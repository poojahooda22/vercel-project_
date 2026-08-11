import { exec } from "child_process";
import path from "path";

// The only variables the build child is allowed to see. Everything else in the
// worker's environment is withheld.
//
// This matters because `npm install` executes preinstall/install/postinstall scripts
// from the cloned repository AND from every one of its transitive dependencies, as
// this same user. A child process inherits process.env by default, so without this
// list the worker hands S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ACCOUNT_ID and the
// NEON_DB connection string to code nobody here has read — a one-line postinstall is
// enough to exfiltrate all of them.
//
// It is worth being precise about what this does not do: the build still runs
// unsandboxed on the host with full network access, so this is a reduction in what a
// malicious repo gets for free, not isolation. Isolation is a container per build.
const INHERITED_ENV_KEYS = [
    "PATH",       // without it the shell cannot find node or npm
    "LANG",
    "SystemRoot", // the four Windows entries keep local dev on this box working;
    "ComSpec",    // npm resolves through cmd.exe there and fails without them
    "TEMP",
    "TMP",
    "APPDATA",
    "USERPROFILE",
];

function buildEnv(): NodeJS.ProcessEnv {
    // NODE_ENV is deliberately NOT set, and specifically not to "production".
    //
    // npm reads NODE_ENV=production as --omit=dev, so the build tools a project
    // declares in devDependencies — tsc, vite, next, webpack, essentially all of
    // them — never get installed, and `npm run build` dies with "tsc: not found"
    // and exit code 127. The worker's own process has NODE_ENV=production from
    // apps/deploy-service/Dockerfile:29, so the previous code inherited it and had
    // this bug too; building the child's environment explicitly is what exposed it.
    //
    // Leaving it unset matches what `npm run build` does on a developer's machine.
    // Bundlers set their own production mode for the output regardless.
    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    // npm needs a writable home for its cache. In the container the app user owns
    // /tmp; on Windows npm uses APPDATA instead, which is passed through above.
    if (process.platform !== "win32") env.HOME = "/tmp";
    return env;
}

export function buildProject(id: string): Promise<number> {
    return new Promise<number>((resolve) => {
        //exec - node js inbuild process -> go to dist folder inside unique ID and run build
        const child = exec(`cd ${path.join(__dirname, `output/${id}`)} && npm install && npm run build`, {
            env: buildEnv(),
        })

        //logs good for debugging
        child.stdout?.on('data', function(data) {
            console.log('stdout: ' + data);
        });
        child.stderr?.on('data', function(data) {
            console.log('stderr: ' + data);
        });

        // Hand the exit code back. Swallowing it is what made a failed build
        // report as "deployed".
        child.on('close', function(code) {
            resolve(code ?? 1)
        });
    })
}  