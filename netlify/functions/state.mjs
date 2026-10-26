// Shared medal/flag state. One blob per participant so simultaneous edits never clobber each other:
//   <challengeId>/meta          -> { medalsTotal }
//   <challengeId>/e/<teamOrUserId> -> { medal, medalAt, flag, flagAt }
// GET returns the merged view: { medalsTotal, entries: { [id]: {...} } }
// POST { op: "entry", ids: [...], field, value } updates several people at once (e.g. a whole team).
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const ID = /^[A-Za-z0-9-]{1,64}$/;
const FIELDS = ["medal", "flag"];

const json = (body, status = 200) => Response.json(body, { status });
const sha = (s) => createHash("sha256").update(s).digest();
const store = () => getStore({ name: "medals", consistency: "strong" });

function authorized(req) {
  // The client URI-encodes the key so non-Latin passwords survive the HTTP header.
  let given = req.headers.get("x-admin-key") || "";
  try { given = decodeURIComponent(given); } catch { return false; }
  return timingSafeEqual(sha(given), sha(process.env.ADMIN_PASSWORD));
}

function validate(body) {
  if (!body || !ID.test(body.challengeId || "")) return "Invalid challengeId";
  if (body.op === "medalsTotal") {
    const v = body.value;
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100000)) return "Invalid medal count";
    return null;
  }
  if (body.op === "entry") {
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => ID.test(id))) return "Invalid ids";
    if (!FIELDS.includes(body.field)) return "Invalid field";
    if (typeof body.value !== "boolean") return "Invalid value";
    return null;
  }
  return "Unknown op";
}

async function readChallenge(s, challengeId) {
  const prefix = `${challengeId}/e/`;
  const [meta, listing] = await Promise.all([
    s.get(`${challengeId}/meta`, { type: "json" }),
    s.list({ prefix }),
  ]);
  const values = await Promise.all(listing.blobs.map((b) => s.get(b.key, { type: "json" })));
  const entries = {};
  listing.blobs.forEach((b, i) => {
    if (values[i]) entries[b.key.slice(prefix.length)] = values[i];
  });
  return { medalsTotal: meta?.medalsTotal ?? null, entries };
}

export default async (req) => {
  if (!process.env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD is not set in Netlify environment variables" }, 500);
  }
  if (!authorized(req)) return json({ error: "Wrong password" }, 401);

  const s = store();

  if (req.method === "GET") {
    const challengeId = new URL(req.url).searchParams.get("challengeId");
    if (!challengeId) return json({ ok: true }); // login check
    if (!ID.test(challengeId)) return json({ error: "Invalid challengeId" }, 400);
    return json(await readChallenge(s, challengeId));
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await req.json().catch(() => null);
  const error = validate(body);
  if (error) return json({ error }, 400);

  if (body.op === "medalsTotal") {
    await s.setJSON(`${body.challengeId}/meta`, { medalsTotal: body.value });
  } else {
    const at = new Date().toISOString();
    await Promise.all(body.ids.map(async (id) => {
      const key = `${body.challengeId}/e/${id}`;
      const current = (await s.get(key, { type: "json" })) || {};
      await s.setJSON(key, { ...current, [body.field]: body.value, [body.field + "At"]: at });
    }));
  }
  return json(await readChallenge(s, body.challengeId));
};

export const config = { path: "/api/state" };
