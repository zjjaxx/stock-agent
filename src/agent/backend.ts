import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  CompositeBackend,
  FilesystemBackend,
  LocalShellBackend,
} from 'deepagents';

/**
 * LocalShell + permissions 在 execute 时会失败：resolveBackend 适配后丢失
 * routePrefixes，权限校验误判。因此不用 permissions，改用路由隔离：
 * - /tmp、/src/skills、/large_tool_results → 真实磁盘
 * - 其它文件工具路径 → 空 jail 目录（逛不到项目源码）
 * - execute 仍走默认 LocalShellBackend
 */
export function createAgentBackend() {
  const root = process.cwd();
  const tmpDir = join(root, 'tmp');
  const jailDir = join(tmpDir, '.fs-jail');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, 'large_tool_results'), { recursive: true });
  mkdirSync(jailDir, { recursive: true });

  const shell = new LocalShellBackend({
    rootDir: root,
    virtualMode: true,
    inheritEnv: true,
  });

  return new CompositeBackend(shell, {
    '/tmp/': new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: true,
    }),
    '/src/skills/': new FilesystemBackend({
      rootDir: join(root, 'src', 'skills'),
      virtualMode: true,
    }),
    '/large_tool_results/': new FilesystemBackend({
      rootDir: join(tmpDir, 'large_tool_results'),
      virtualMode: true,
    }),
    '/': new FilesystemBackend({
      rootDir: jailDir,
      virtualMode: true,
    }),
  });
}
