type Fields = Record<string, unknown>;

function line(level: string, msg: string, fields?: Fields): void {
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(JSON.stringify(rec) + '\n');
}

export const log = {
  info: (msg: string, fields?: Fields) => line('info', msg, fields),
  warn: (msg: string, fields?: Fields) => line('warn', msg, fields),
  error: (msg: string, fields?: Fields) => line('error', msg, fields),
};
