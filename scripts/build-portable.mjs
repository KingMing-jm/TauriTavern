#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function printHelp() {
    console.log(`Usage: node scripts/build-portable.mjs [options] [-- <extra tauri args>]

Options:
  --target <triple>       Rust target triple, e.g. x86_64-pc-windows-msvc
  --output-dir <path>     Portable output directory (default: release)
  --skip-web-build        Skip frontend bundle build
  --help                  Show this help message
`);
}

function quoteShellArgument(value) {
    if (value.length === 0) {
        return "\"\"";
    }
    if (!/[\s"]/u.test(value)) {
        return value;
    }
    return `"${value.replace(/"/gu, '\\"')}"`;
}

function run(command, args, cwd, env = process.env) {
    const commandLine = [command, ...args.map(quoteShellArgument)].join(" ");
    const result = spawnSync(commandLine, { cwd, env, stdio: "inherit", shell: true });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function parseArgs(argv) {
    const options = {
        target: null,
        outputDir: "release",
        skipWebBuild: false,
        extraTauriArgs: [],
    };

    let passThrough = false;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];

        if (passThrough) {
            options.extraTauriArgs.push(value);
            continue;
        }

        if (value === "--") {
            passThrough = true;
            continue;
        }

        if (value === "--help" || value === "-h") {
            printHelp();
            process.exit(0);
        }

        if (value === "--skip-web-build") {
            options.skipWebBuild = true;
            continue;
        }

        if (value === "--target") {
            const target = argv[index + 1];
            if (!target) {
                throw new Error("Missing value for --target");
            }
            options.target = target;
            index += 1;
            continue;
        }

        if (value === "--output-dir") {
            const outputDir = argv[index + 1];
            if (!outputDir) {
                throw new Error("Missing value for --output-dir");
            }
            options.outputDir = outputDir;
            index += 1;
            continue;
        }

        options.extraTauriArgs.push(value);
    }

    return options;
}

function resolveReleaseDirectory(repoRoot, target) {
    const releaseRoot = target
        ? path.join(repoRoot, "src-tauri", "target", target, "release")
        : path.join(repoRoot, "src-tauri", "target", "release");
    return releaseRoot;
}

function resolvePortableBinary(releaseDirectory, config) {
    const executableSuffix = process.platform === "win32" ? ".exe" : "";
    const binaryName = config.mainBinaryName ?? "tauritavern";
    const binaryPath = path.join(releaseDirectory, `${binaryName}${executableSuffix}`);
    if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
        throw new Error(`Unable to locate built portable binary: ${binaryPath}`);
    }
    return binaryPath;
}

function normalizePlatform(platform) {
    if (platform === "win32") {
        return "windows";
    }
    if (platform === "darwin") {
        return "macos";
    }
    return platform;
}

function normalizeArch(arch) {
    if (arch === "x64") {
        return "x64";
    }
    if (arch === "ia32") {
        return "x86";
    }
    return arch;
}

function buildPlatformTag(target) {
    if (target) {
        return target.replace(/[^a-zA-Z0-9._-]/g, "_");
    }
    return `${normalizePlatform(process.platform)}-${normalizeArch(process.arch)}`;
}

function main() {
    const repoRoot = process.cwd();
    const options = parseArgs(process.argv.slice(2));

    const tauriArgs = ["scripts/tauri-app.mjs", "build", "--no-bundle", "--features", "portable"];
    if (options.target) {
        tauriArgs.push("--target", options.target);
    }
    if (options.extraTauriArgs.length > 0) {
        tauriArgs.push(...options.extraTauriArgs);
    }
    const tauriEnv = options.skipWebBuild
        ? { ...process.env, TAURITAVERN_SKIP_WEB_BUILD: "1" }
        : process.env;
    run("node", tauriArgs, repoRoot, tauriEnv);

    const releaseDirectory = resolveReleaseDirectory(repoRoot, options.target);
    const config = JSON.parse(readFileSync(path.join(repoRoot, "src-tauri/crates/tauritavern/tauri.conf.json"), "utf8"));
    const binaryPath = resolvePortableBinary(releaseDirectory, config);
    const outputDirectory = path.resolve(repoRoot, options.outputDir);
    mkdirSync(outputDirectory, { recursive: true });

    const extension = process.platform === "win32" ? ".exe" : "";
    const artifactName = `${config.productName}-${buildPlatformTag(options.target)}-portable${extension}`;
    const artifactPath = path.join(outputDirectory, artifactName);
    copyFileSync(binaryPath, artifactPath);

    console.log(`Portable binary copied to ${artifactPath}`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
