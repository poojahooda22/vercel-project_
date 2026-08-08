import { exec } from "child_process";
import path from "path";


export function buildProject(id: string): Promise<number> {
    return new Promise<number>((resolve) => {
        //exec - node js inbuild process -> go to dist folder inside unique ID and run build 
        const child = exec(`cd ${path.join(__dirname, `output/${id}`)} && npm install && npm run build`)

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