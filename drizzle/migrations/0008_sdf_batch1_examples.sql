CREATE INDEX example_artifacts_app_idx ON public.example_artifacts(app_id);
INSERT INTO public.apps(id,name,description,phase,classification,redact_before_llm,current_version,created_by,source) VALUES
('1c000000-0000-4000-8000-000000000001','澄远零售门店智能补货','示例数据 · 门店补货建议、库存与审批。仅包含基础信息与查看样例。','maintenance','internal',true,'v1.1','9658df76-26aa-4a00-aa53-5592e9656433','seed'),
('1c000000-0000-4000-8000-000000000002','门店巡检助手','示例数据 · 巡检信息收集。运行与需求尚未实施。','development','internal',true,NULL,'9658df76-26aa-4a00-aa53-5592e9656433','seed');
INSERT INTO public.contacts(id,name,title,org,is_demo,created_by) VALUES
('1c000000-0000-4000-8000-000000000011','吴姐','门店店长','澄远零售',true,'9658df76-26aa-4a00-aa53-5592e9656433'),
('1c000000-0000-4000-8000-000000000012','马磊','交付负责人','示例团队',true,'9658df76-26aa-4a00-aa53-5592e9656433'),
('1c000000-0000-4000-8000-000000000013','林可','业务分析师','示例团队',true,'9658df76-26aa-4a00-aa53-5592e9656433'),
('1c000000-0000-4000-8000-000000000014','赵衡','架构师','示例团队',true,'9658df76-26aa-4a00-aa53-5592e9656433'),
('1c000000-0000-4000-8000-000000000015','许安','信息安全','示例团队',true,'9658df76-26aa-4a00-aa53-5592e9656433'),
('1c000000-0000-4000-8000-000000000016','周宇','开发负责人','示例团队',true,'9658df76-26aa-4a00-aa53-5592e9656433');
INSERT INTO public.app_contacts(app_id,contact_id,app_role,is_business) VALUES
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000011','business',true),
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000012','lead',false),
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000013','ba',false),
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000014','architect',false),
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000015','security',false),
('1c000000-0000-4000-8000-000000000001','1c000000-0000-4000-8000-000000000016','dev',false),
('1c000000-0000-4000-8000-000000000002','1c000000-0000-4000-8000-000000000012','lead',false),
('1c000000-0000-4000-8000-000000000002','1c000000-0000-4000-8000-000000000013','ba',false);
INSERT INTO public.example_catalog(id,kind,name,batch) VALUES
('B02','block','需求整理','2'),('B03','block','需求分析','2'),('B04','block','澄清问题','2'),('B05','block','变更方案与影响分析','5'),('B06','block','知识库问答','future'),('B07','block','交付效率统计','future'),('B08','block','工程规范','2'),('B09','block','原型','3'),('B10','block','数据模型','3'),('B11','block','接口定义','3'),('B12','block','架构与决策','3'),('B13','block','部署包生成','future'),('B14','block','任务拆分','3'),('B15','block','交给开发','4'),('B16','block','代码库概况','4'),('B17','block','代码评审助手','future'),('B18','block','测试设计','3'),('B19','block','故障原因分析','future'),('B20','block','报告导入','4'),('B21','block','交付检查','4'),('B22','block','流水线文件','3'),('B23','block','规划积木 B23','future'),('B24','block','发布说明','5'),('B25','block','规划积木 B25','future'),('B26','block','文档','3'),('B27','block','规划积木 B27','future'),('B28','block','规划积木 B28','future'),('B29','block','任务看板','3'),('B30','block','规划积木 B30','future'),('B31','block','反馈分类','5'),('B32','block','变更请求与业务确认','5'),('B33','block','业务验收','5'),
('business_analyst','agent','业务分析师','2'),('architect','agent','架构师','3'),('data_modeler','agent','数据建模师','3'),('api_designer','agent','接口设计师','3'),('test_designer','agent','测试设计师','3'),('task_planner','agent','任务规划师','3'),('handoff_coordinator','agent','开发交接员','4'),('document_writer','agent','文档撰写员','3'),('business_assistant','agent','业务沟通助手','5');
INSERT INTO public.example_artifacts(app_id,title,format,version,content) VALUES
('1c000000-0000-4000-8000-000000000001','工程规范','markdown',1,E'# 工程规范\n\n示例数据\n\n## 安全\n- 所有业务查询必须校验应用权限。\n- 凭据不得进入日志。\n\n## 补货审批\n- 补货建议需要门店负责人确认。\n'),
('1c000000-0000-4000-8000-000000000001','工程规范','markdown',2,E'# 工程规范\n\n示例数据\n\n## 安全\n- 所有业务查询必须校验应用权限。\n- 凭据不得进入日志。\n- 模型调用前清除个人敏感信息。\n\n## 补货审批\n- 补货建议需要门店负责人确认。\n'),
('1c000000-0000-4000-8000-000000000001','数据模型片段','json',1,'{"source":"seed","entities":[{"name":"store","fields":["id","name"]},{"name":"replenishment","fields":["id","store_id","status"]}]}'),
('1c000000-0000-4000-8000-000000000001','接口定义片段','yaml',1,E'openapi: 3.1.0\ninfo:\n  title: 补货示例接口\n  version: 0.1.0\npaths:\n  /replenishments:\n    get:\n      summary: 查看补货建议\n      responses:\n        "200":\n          description: 示例数据\n'),
('1c000000-0000-4000-8000-000000000001','架构图','mermaid',1,E'flowchart LR\n  Store[门店] --> Review[补货审批]\n  Review --> Inventory[库存记录]\n'),
('1c000000-0000-4000-8000-000000000002','巡检说明','markdown',1,E'# 门店巡检助手\n\n示例数据\n\n## 巡检范围\n- 货架陈列\n- 库存差异\n- 现场问题记录\n');