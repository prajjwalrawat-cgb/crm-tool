import { auth } from '@/lib/auth/server';
import { redirect } from 'next/navigation';

export default async function Home() {
  const { userId } = await auth();
  redirect(userId ? '/dashboard' : '/sign-in');
}
