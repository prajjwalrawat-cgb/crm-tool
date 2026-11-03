// This workspace's AskMira connection: GET to read it, DELETE to disconnect.
export const dynamic = 'force-dynamic';
export { connectionRoute as GET, disconnectRoute as DELETE } from '@/lib/askmira/handlers';
