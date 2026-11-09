// Testa o server-filesystem pelo protocolo MCP, iniciando-o como o config faz (cmd /c npx ...).
// O npx baixa o pacote @modelcontextprotocol/server-filesystem se ele nao estiver em cache.
//
// Uso (Windows):
//   node testar-mcp.js [opcoes] "\\SERVIDOR\Obsidian" [outro caminho ...]
//
// Todos os caminhos vao para um unico servidor, como na lista "args" do config.
// Opcoes:
//   --confine-roots   repassada ao servidor (veja o README)
//   --read-only       repassada ao servidor
//   --root <pasta>    simula um cliente que informa <pasta> como Root, como faz
//                     uma sessao do Code ou do Cowork; pode repetir
// Troque SERVIDOR pelo nome ou IP do servidor.
const { spawn, execSync } = require('child_process');
const { pathToFileURL } = require('url');

const TIMEOUT_MS = 60000;
// Tempo para o servidor aplicar as Roots depois de recebe-las.
const ROOTS_DELAY_MS = 1500;

function parseArgs(argv) {
  const flags = [];
  const roots = [];
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confine-roots' || a === '--read-only') flags.push(a);
    else if (a === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root precisa de uma pasta');
      roots.push(argv[++i]);
    } else paths.push(a);
  }
  return { flags, roots, paths };
}

function run({ flags, roots, paths }) {
  return new Promise((resolve) => {
    const serverArgs = [...flags, ...paths];
    console.log(`\n=== server-filesystem ${serverArgs.join(' ')} ===`);
    if (roots.length) console.log(`Roots simuladas: ${roots.join(', ')}`);
    const t0 = Date.now();
    const p = spawn('cmd', ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', ...serverArgs], {
      stdio: 'pipe',
      windowsHide: true,
    });
    let buf = '';
    let stderr = '';
    const waiting = new Map();

    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

    p.stderr.on('data', (d) => (stderr += d));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.method === 'roots/list' && m.id !== undefined) {
            // Pedido do servidor ao cliente: responde com as Roots simuladas.
            send({
              jsonrpc: '2.0',
              id: m.id,
              result: { roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: r })) },
            });
          } else if (waiting.has(m.id)) {
            waiting.get(m.id)(m);
            waiting.delete(m.id);
          } else {
            console.log('(nao solicitado)', line.slice(0, 200));
          }
        } catch {
          console.log('(stdout nao JSON)', line.slice(0, 200));
        }
      }
    });

    const call = (id, method, params) =>
      new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error(`timeout em ${method}`)), TIMEOUT_MS);
        waiting.set(id, (m) => {
          clearTimeout(to);
          res(m);
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    const short = (o) => {
      const s = JSON.stringify(o);
      return s.length > 500 ? s.slice(0, 500) + ' ...' : s;
    };
    const finish = () => {
      try {
        execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' });
      } catch {}
      console.log('--- stderr ---');
      console.log(stderr.split('\n').filter((l) => !/npm notice/.test(l)).join('\n').trim());
      resolve();
    };

    p.on('error', (e) => console.log('Falha ao iniciar:', e.message));

    (async () => {
      try {
        const init = await call(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: roots.length ? { roots: { listChanged: true } } : {},
          clientInfo: { name: 'testar-mcp', version: '1' },
        });
        console.log(`initialize OK em ${Date.now() - t0} ms:`, short(init.result.serverInfo));
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        if (roots.length) await new Promise((r) => setTimeout(r, ROOTS_DELAY_MS));
        const allowed = await call(2, 'tools/call', { name: 'list_allowed_directories', arguments: {} });
        console.log('allowed:', short(allowed.result));
        let id = 3;
        for (const path of paths) {
          const list = await call(id++, 'tools/call', { name: 'list_directory', arguments: { path } });
          console.log(`list_directory ${path}:`, short(list.result));
        }
      } catch (e) {
        console.log('FALHA:', e.message);
        process.exitCode = 1;
      }
      finish();
    })();
  });
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.paths.length === 0) {
    console.error(
      'Uso: node testar-mcp.js [--confine-roots] [--read-only] [--root <pasta>] "\\\\SERVIDOR\\Obsidian" [outro caminho ...]'
    );
    process.exit(2);
  }
  await run(opts);
})();
