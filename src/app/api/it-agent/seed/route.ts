import { seedAll } from '@/lib/it-agent/seed-knowledge';
import { ok } from '@/lib/http';
export async function POST() {
  return ok(seedAll(false));
}
export async function GET() {
  return ok(seedAll(false));
}
