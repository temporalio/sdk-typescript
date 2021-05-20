"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitOnChild = exports.spawn = exports.ChildProcessError = void 0;
const child_process_1 = require("child_process");
class ChildProcessError extends Error {
    constructor(message, code, signal) {
        super(message);
        this.code = code;
        this.signal = signal;
        this.name = 'ChildProcessError';
    }
}
exports.ChildProcessError = ChildProcessError;
async function spawn(command, args, options) {
    try {
        // Workaround @types/node - avoid choosing overloads per options.stdio variants
        await waitOnChild(options === undefined ? child_process_1.spawn(command, args) : child_process_1.spawn(command, args || [], options));
    }
    catch (err) {
        if (err instanceof ChildProcessError) {
            err.command = command;
            err.args = args;
        }
        throw err;
    }
}
exports.spawn = spawn;
async function waitOnChild(child) {
    return new Promise((resolve, reject) => {
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
            }
            else {
                reject(new ChildProcessError('Process failed', code, signal));
            }
        });
        child.on('error', reject);
    });
}
exports.waitOnChild = waitOnChild;
//# sourceMappingURL=subprocess.js.map