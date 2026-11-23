export type PipelineTarget = "gitlab" | "jenkins" | "azure" | "gitea";

const HOOK = `curl -fsS -X POST "$SDF_INGEST_URL/api/public/hooks/ingest/reports" -H "Authorization: Bearer $SDF_INGEST_TOKEN" -F "junit=@test-results.xml" -F "sarif=@gl-sast.sarif"`;

function body(target: PipelineTarget, build: string): string {
  const test = `${build.trim() || "npm test"}\n${HOOK}`;
  if (target === "gitlab") return `stages: [test]\n\ntest:\n  stage: test\n  script:\n${test.split("\n").map((l) => `    - ${l}`).join("\n")}\n`;
  if (target === "jenkins") return `pipeline {\n  agent any\n  stages {\n    stage('test') {\n      steps {\n        sh '''${test}'''\n      }\n    }\n  }\n}\n`;
  if (target === "azure") return `trigger:\n- main\npool:\n  vmImage: ubuntu-latest\nsteps:\n- script: |\n${test.split("\n").map((l) => `    ${l}`).join("\n")}\n  displayName: test\n`;
  return `name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: |\n${test.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
}

export function pipelineFilename(target: PipelineTarget): string {
  return { gitlab: ".gitlab-ci.yml", jenkins: "Jenkinsfile", azure: "azure-pipelines.yml", gitea: ".gitea/workflows/ci.yml" }[target];
}

export function renderPipeline(target: PipelineTarget, buildCommand: string): string {
  const text = body(target, buildCommand);
  if (!text.includes("/api/public/hooks/ingest/reports")) throw new Error("流水线缺少报告回传步骤");
  return text;
}
