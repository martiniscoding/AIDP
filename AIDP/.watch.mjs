import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
for (let i = 0; i < 90; i++) {
  const docs = await sql`select title, status, "pageCount", (select count(*)::int from "chunk" c where c."documentId"=d.id) chunks from "document" d order by "createdAt"`;
  const done = docs.length > 0 && docs.every(d => d.status === "ready" || d.status === "failed");
  if (done || i % 6 === 0) {
    console.log(`t+${i*5}s`);
    for (const d of docs) console.log(`   ${d.title.slice(0,44).padEnd(44)} ${d.status.padEnd(10)} ${d.pageCount??"-"}pp ${d.chunks} chunks`);
  }
  if (done) break;
  await new Promise(r => setTimeout(r, 5000));
}
