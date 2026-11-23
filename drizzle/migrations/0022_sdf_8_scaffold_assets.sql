-- 阶段 6：只改三个积木的名称和已实施状态，不新增目录行。
UPDATE public.example_catalog
SET name = CASE id
  WHEN 'B13' THEN '模板脚手架'
  WHEN 'B28' THEN '资产与应用目录'
  WHEN 'B29' THEN '轻量任务板'
  ELSE name
END,
batch = '8',
status = 'implemented'
WHERE kind = 'block' AND id IN ('B13', 'B28', 'B29');
