import { signOut } from "@/server/actions/auth";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded border border-line px-2 py-1 hover:border-accent"
      >
        Sign out
      </button>
    </form>
  );
}
