import { AuthShell } from '@/components/auth/auth-shell';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <AuthShell subtitle="Enter your email and we'll send you a link to set a new password.">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
