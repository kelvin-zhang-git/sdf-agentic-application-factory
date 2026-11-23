-- 阶段 5：只改积木目录的名称和已实施状态，不新增行。健康检查仍按 33 个积木、10 个角色计数。
UPDATE public.example_catalog
SET name = CASE id
  WHEN 'B06' THEN '方案草图'
  WHEN 'B07' THEN '优先级'
  WHEN 'B19' THEN '测试脚本'
  WHEN 'B23' THEN '部署包'
  ELSE name
END,
batch = CASE WHEN id IN ('B06', 'B07', 'B19', 'B23') THEN '6' ELSE batch END,
status = 'implemented'
WHERE kind = 'block'
  AND id IN (
    'B01','B02','B03','B04','B05','B06','B07','B08','B09','B10','B11','B12',
    'B14','B15','B16','B18','B19','B20','B21','B22','B23','B24','B26','B31','B32','B33'
  );
