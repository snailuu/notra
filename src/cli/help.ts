export function printHelp(): void {
  console.log(`notra CLI

Getting started:
  notra init                         一站式初始化 Notra
  notra start "任务描述"              开始任务前获取项目知识建议
  notra finish "任务总结"             完成任务后沉淀知识
  notra status                       查看知识库状态
  notra doctor                       诊断 Notra 配置和知识库健康度

Advanced:
  notra project-init [project-root]   仅初始化项目知识库
  notra preflight [project-root] ...  底层 preflight
  notra crystallize [project-root] [input.json|--input input.json]
  notra auto-crystallize [project-root] [input.json|--input input.json]
  notra lint [project-root]
  notra govern [project-root]
  notra graph [project-root|knowledge-root]
  notra serve [project-root] [port]

Options:
  --project-root, -C <path>  指定目标项目目录
  --json                    输出机器可读 JSON
  --yes, -y                 跳过确认，使用默认值
  --no-interactive          禁用交互式提示
  --dry-run                 只预览写入内容
  --force                   覆盖冲突文件
  --skip-existing           跳过冲突文件
  --platform-only           init 时只安装平台 skill/runtime
  --project-only            init 时只初始化 .notra 知识库
  --claude|--codex|--agents|--all  选择安装平台
  --strict                  doctor 存在失败项时返回非零退出码
  --version, -v             输出版本号
  --help, -h                输出帮助`);
}
