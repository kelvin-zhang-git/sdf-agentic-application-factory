CREATE OR REPLACE FUNCTION public.find_profile_id_by_email(_email text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id FROM public.profiles p
  WHERE lower(p.email) = lower(trim(_email))
    AND public.has_global_role(ARRAY['admin','lead'])
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.find_profile_id_by_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_profile_id_by_email(text) TO authenticated, service_role;