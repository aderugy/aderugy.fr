-- Vault helpers.
--
-- Refresh tokens are long-lived credentials to a third-party account. They live
-- in Supabase Vault (encrypted at rest, key managed outside the table) and are
-- reachable only through these functions, which the service role alone may call.
--
-- If this file errors with `schema "vault" does not exist`, enable the
-- `supabase_vault` extension for the project first. It is on by default for
-- projects created through the dashboard.

create or replace function public.vault_store(p_secret text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
begin
  select id into secret_id from vault.secrets where name = p_name;

  if secret_id is null then
    secret_id := vault.create_secret(p_secret, p_name, 'Google refresh token');
  else
    perform vault.update_secret(secret_id, p_secret, p_name);
  end if;

  return secret_id;
end;
$$;

create or replace function public.vault_read(p_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id;
$$;

create or replace function public.vault_forget(p_id uuid)
returns void
language sql
security definer
set search_path = public, vault
as $$
  delete from vault.secrets where id = p_id;
$$;

revoke execute on function public.vault_store(text, text) from public, authenticated, anon;
revoke execute on function public.vault_read(uuid)        from public, authenticated, anon;
revoke execute on function public.vault_forget(uuid)      from public, authenticated, anon;
