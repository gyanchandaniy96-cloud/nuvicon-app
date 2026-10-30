// Supabase Edge Function: razorpay
// Secrets needed (Supabase -> Edge Functions -> Secrets):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (optional but recommended)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const enc = new TextEncoder();
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return Array.from(sig).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "";
  const secret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  const whSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";

  async function markPaid(order: any, paymentId: string, via: string) {
    if (order.pay_status === "paid") return null;
    if (order.status === "cancelled") {
      await db.from("audit_log").insert({ action: "payment_after_cancel", entity: "orders", entity_id: String(order.id),
        details: { payment_id: paymentId, via, note: "Order was cancelled, refund the payment" } });
      return null;
    }
    const up = await db.from("orders").update({ pay_status: "paid", razorpay_payment_id: paymentId })
      .eq("id", order.id).eq("pay_status", "pending").select("id");
    if (up.error) { console.error("markPaid update failed", up.error); return up.error.message; }
    const al = await db.from("audit_log").insert({ action: "payment_received", entity: "orders", entity_id: String(order.id),
      details: { payment_id: paymentId, via, amount: order.total } });
    if (al.error) console.error("audit insert failed", al.error);
    return null;
  }

  // ---- Razorpay webhook (backup if the customer closes the app after paying)
  const wsig = req.headers.get("x-razorpay-signature");
  if (wsig) {
    const raw = await req.text();
    if (!whSecret || !same(await hmac(whSecret, raw), wsig)) return json({ error: "Bad signature" }, 401);
    const evt = JSON.parse(raw);
    if (evt.event === "payment.captured" || evt.event === "order.paid") {
      const pay = evt.payload?.payment?.entity;
      if (pay?.order_id) {
        const { data: o } = await db.from("orders").select("id,status,pay_status,total").eq("razorpay_order_id", pay.order_id).maybeSingle();
        if (o && Math.round(Number(o.total) * 100) === Number(pay.amount)) await markPaid(o, pay.id, "webhook");
      }
    }
    return json({ ok: true });
  }

  // ---- calls from the customer app
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "Login required" }, 401);
    if (!keyId || !secret) return json({ error: "Payment setup is incomplete" }, 500);
    const body = await req.json();
    const { data: o } = await db.from("orders")
      .select("id,order_no,status,pay_method,pay_status,total,razorpay_order_id")
      .eq("id", body.order).eq("customer_id", u.user.id).maybeSingle();
    if (!o) return json({ error: "Order not found" }, 404);
    if (o.pay_method !== "online") return json({ error: "This is not an online-payment order" }, 400);

    if (body.action === "create") {
      if (o.pay_status !== "pending" || o.status !== "placed") return json({ error: "This order can no longer be paid" }, 400);
      const amount = Math.round(Number(o.total) * 100);
      let rid = o.razorpay_order_id as string | null;
      if (!rid) {
        const r = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(keyId + ":" + secret) },
          body: JSON.stringify({ amount, currency: "INR", receipt: "nuv_" + o.order_no, notes: { order_id: String(o.id) } }),
        });
        const rj = await r.json();
        if (!r.ok) return json({ error: rj?.error?.description || "Could not create the Razorpay order" }, 502);
        rid = rj.id;
        await db.from("orders").update({ razorpay_order_id: rid }).eq("id", o.id);
      }
      return json({ key_id: keyId, rzp_order_id: rid, amount, order_no: o.order_no });
    }

    if (body.action === "verify") {
      if (!o.razorpay_order_id || !body.payment_id || !body.signature) return json({ error: "Payment details are incomplete" }, 400);
      const good = await hmac(secret, o.razorpay_order_id + "|" + body.payment_id);
      if (!same(good, String(body.signature))) return json({ error: "Payment could not be verified" }, 400);
      const e1 = await markPaid(o, String(body.payment_id), "app");
      if (e1) return json({ error: "Could not save the payment: " + e1 }, 500);
      return json({ ok: true });
    }

    // Safety net: ask Razorpay directly whether this order has been paid, and record it if so
    if (body.action === "sync") {
      if (o.pay_status === "paid") return json({ ok: true, paid: true });
      if (!o.razorpay_order_id) return json({ ok: true, paid: false });
      const r = await fetch("https://api.razorpay.com/v1/orders/" + o.razorpay_order_id + "/payments", {
        headers: { Authorization: "Basic " + btoa(keyId + ":" + secret) },
      });
      const rj = await r.json();
      if (!r.ok) return json({ error: rj?.error?.description || "Could not check the payment" }, 502);
      const pay = (rj.items || []).find((x: any) => x.status === "captured" && Number(x.amount) === Math.round(Number(o.total) * 100));
      if (!pay) return json({ ok: true, paid: false, statuses: (rj.items || []).map((x: any) => x.status) });
      const e2 = await markPaid(o, String(pay.id), "sync");
      if (e2) return json({ error: "Could not save the payment: " + e2 }, 500);
      return json({ ok: true, paid: true });
    }
    return json({ error: "Invalid request" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
