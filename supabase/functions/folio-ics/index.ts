// Folio calendar feed: serves one account's events as an iCalendar (.ics) feed
// that Apple Calendar, Google Calendar or Outlook can subscribe to.
// Access is by the private random token in the link (?t=…), created in Folio.
import { createClient } from "npm:@supabase/supabase-js@2";

type Ev = { id: string; title: string; date: string; allDay?: boolean; startUTC?: string; endUTC?: string; note?: string; updated?: string };

const esc = (t: string) => String(t ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");
const nextDay = (d: string) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
// Lines longer than 75 bytes are folded, as the iCalendar format asks.
const fold = (line: string) => {
  const out: string[] = []; let cur = ""; let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
};

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (token.length < 32) return new Response("Not found", { status: 404 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: feed } = await sb.from("folio_feeds").select("user_id").eq("token", token).maybeSingle();
  if (!feed) return new Response("Not found", { status: 404 });

  const { data: doc } = await sb.from("folio_docs").select("data").eq("user_id", feed.user_id).eq("key", "app/calendar/events").maybeSingle();
  const events: Ev[] = Array.isArray(doc?.data?.events) ? doc!.data.events : [];

  const now = utc(new Date().toISOString());
  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Folio//Planner//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Folio", "X-WR-CALDESC:Events from your Folio planners",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  for (const e of events) {
    if (!e || !e.id || !e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    L.push("BEGIN:VEVENT", "UID:" + e.id + "@folio", "DTSTAMP:" + (e.updated ? utc(e.updated) : now));
    if (e.allDay || !e.startUTC) L.push("DTSTART;VALUE=DATE:" + day(e.date), "DTEND;VALUE=DATE:" + day(nextDay(e.date)));
    else L.push("DTSTART:" + utc(e.startUTC), "DTEND:" + utc(e.endUTC || e.startUTC));
    L.push(fold("SUMMARY:" + esc(e.title || "Event")));
    if (e.note) L.push(fold("DESCRIPTION:" + esc(e.note)));
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");

  return new Response(L.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="folio.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
});
