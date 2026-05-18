/**
 * Shared appearance config for Clerk's hosted auth widgets
 * (<SignIn />, <SignUp />, the invite-accept flow). Lives outside the
 * route files so any future widget — e.g. <UserProfile /> — picks up
 * the same look without re-tuning.
 *
 * Tokens deliberately mirror the dashboard's Tailwind palette:
 *   - indigo-600 for primary action surfaces
 *   - slate-200 borders, slate-50/60 inputs
 *   - rounded-lg cards with a subtle shadow
 *
 * Clerk's `appearance` API is a plain JSON object — safe to import
 * from a server component and pass through as a prop.
 */
/**
 * Note: not importing the `Appearance` type from `@clerk/types` —
 * it's a transitive dep, not a direct one, so importing it would add
 * a phantom dependency that breaks on a clean install. Clerk accepts
 * a plain JSON object here; the shape is validated at the call site.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#4f46e5', // indigo-600
    colorText: '#0f172a', // slate-900
    colorTextSecondary: '#475569', // slate-600
    colorBackground: '#ffffff',
    colorInputBackground: '#f8fafc', // slate-50
    colorInputText: '#0f172a',
    colorDanger: '#e11d48', // rose-600
    colorSuccess: '#059669', // emerald-600
    colorWarning: '#d97706', // amber-600
    colorNeutral: '#0f172a',
    borderRadius: '0.5rem', // matches rounded-lg
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif',
    fontSize: '14px',
    spacingUnit: '1rem',
  },
  elements: {
    rootBox: 'mx-auto w-full max-w-[26rem]',
    card:
      'rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-100/60',
    headerTitle: 'text-[20px] font-semibold tracking-tight text-slate-900',
    headerSubtitle: 'text-[13px] text-slate-500',
    formButtonPrimary:
      'bg-indigo-600 hover:bg-indigo-500 text-white text-[13.5px] font-medium ' +
      'shadow-sm transition focus:outline-none focus:ring-2 focus:ring-indigo-500/30',
    formFieldInput:
      'border border-slate-200 bg-white text-[13.5px] text-slate-900 ' +
      'focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20',
    formFieldLabel: 'text-[12px] font-medium text-slate-700',
    footerActionText: 'text-[12px] text-slate-500',
    footerActionLink: 'text-[12px] font-medium text-indigo-600 hover:text-indigo-500',
    identityPreviewText: 'text-[13px] text-slate-700',
    identityPreviewEditButton: 'text-[12px] text-indigo-600 hover:text-indigo-500',
    formFieldErrorText: 'text-[11.5px] text-rose-600',
    alertText: 'text-[12.5px] text-rose-700',
    // Pre-emptively hide the social-buttons container in case a Clerk
    // dashboard toggle is flipped on by mistake — the email-only stance
    // is enforced at the UI layer too, not just the dashboard config.
    socialButtonsRoot: 'hidden',
    socialButtonsBlockButton: 'hidden',
    dividerRow: 'hidden',
  },
  layout: {
    socialButtonsPlacement: 'bottom',
    socialButtonsVariant: 'iconButton',
    showOptionalFields: false,
  },
};
