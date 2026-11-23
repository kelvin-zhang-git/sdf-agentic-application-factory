# 批次 2A 数据与权限验收

新增：app_counters、workflows、workflow_runs、step_runs、step_chunk_results、step_events、artifacts、sources、source_segments、requirements、acceptance_criteria、requirement_versions、analysis_findings、clarification_questions；llm_providers.provider_type（仅 openai_compatible）；私有存储桶 sources（10MB，按 {app_id}/ 路径校验成员角色）。

数据库检查（单个事务内执行后全部撤销）：
| 检查 | 结果 |
|---|---|
| 编号生成 next_code | R-0002 连续生成 |
| 同一运行两个 running 步骤 | 拒绝 |
| 步骤与运行跨应用 | 拒绝 |
| waiting_model 无 wait_reason | 拒绝 |
| 分片重复写入 | 仅保留首条（1 行，payload=1） |
| 需求引用其他应用段落 | 拒绝 |
| 修改内置工作流 | 拒绝 |
| 普通用户直接写需求 / 制品 / 工作流 | 拒绝 |
| 普通用户调用 next_code | 拒绝 |

未完成：引擎 RPC 与并发集成测试（2B）。
