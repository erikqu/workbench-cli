export const UPDATE_RESTART_EXIT_CODE = 75;

export function updateRestartHasSupervisor(
  env: Record<string, string | undefined> = Bun.env
): boolean {
  return (
    env.WORKBENCH_CLI_RESTART_SUPERVISOR === "1" ||
    env.WORKBENCH_CLI_HOT === "1"
  );
}

export function updateRestartCommand(
  launcher: string,
  argv: readonly string[] = process.argv
): string[] {
  return [launcher, ...argv.slice(2)];
}
