-- 阶段 8：个人访问令牌。明文只在签发时返回一次，库里只留 bcrypt 哈希。
CREATE TABLE public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  token_prefix text NOT NULL,
  token_hash text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_prefix_idx ON public.api_tokens(token_prefix) WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON public.api_tokens TO authenticated;
GRANT ALL ON public.api_tokens TO service_role;
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_tokens_own ON public.api_tokens FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

UPDATE public.example_catalog
SET name = '代码评审助手', batch = '10', status = 'implemented'
WHERE id = 'B17' AND kind = 'block';
UPDATE public.example_catalog
SET name = '交付流度量', batch = '10', status = 'implemented'
WHERE id = 'B30' AND kind = 'block';
