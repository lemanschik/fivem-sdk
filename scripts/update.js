#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');

// --- Configuration ---
const FIVEM_USER = "fivem";
const BASE_DIR = `/home/${FIVEM_USER}`;
const SERVER_DIR = `${BASE_DIR}/server`;
const LATEST_URL = "https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/";

// --- Helper Functions ---
const log = {
    info: (msg) => console.log(chalk.blue.bold(`[INFO] `) + msg),
    success: (msg) => console.log(chalk.green.bold(`[SUCCESS] `) + msg),
    error: (msg) => console.log(chalk.red.bold(`[ERROR] `) + msg),
};

const run = (command) => {
    try {
        execSync(command, { stdio: 'pipe', encoding: 'utf-8' });
    } catch (e) {
        log.error(`Command failed: ${command}`);
        log.error(e.stdout);
        log.error(e.stderr);
        process.exit(1);
    }
};

// --- Main Update Logic ---
async function main() {
    console.log(chalk.magenta.bold("\n### FiveM Server NodeJS Auto-Update Script ###"));
    const startTime = new Date();
    log.info(`Update process started at ${startTime.toISOString()}`);

    // 1. Stop the server
    log.info("Stopping FiveM service...");
    run('sudo systemctl stop fivem');

    // 2. Clean old files
    log.info("Removing old server files...");
    const alpinePath = path.join(SERVER_DIR, 'alpine');
    const runShPath = path.join(SERVER_DIR, 'run.sh');
    if (fs.existsSync(alpinePath)) fs.rmSync(alpinePath, { recursive: true, force: true });
    if (fs.existsSync(runShPath)) fs.unlinkSync(runShPath);

    // 3. Download and extract the latest version
    try {
        log.info("Finding and downloading latest FXServer build...");
        const response = await axios.get(LATEST_URL);
        const latestBuild = response.data.match(/href="([0-9-a-f]{40,}\/)"/)[1];
        const downloadUrl = `${LATEST_URL}${latestBuild}fx.tar.xz`;
        const downloadPath = path.join(SERVER_DIR, 'fx.tar.xz');

        const writer = fs.createWriteStream(downloadPath);
        const downloadStream = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
        });
        downloadStream.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        log.info("Download complete. Extracting...");
        run(`sudo tar -xJf ${downloadPath} -C ${SERVER_DIR}`);
        fs.unlinkSync(downloadPath);

    } catch (e) {
        log.error("Failed to download or extract new FXServer build. Restarting server with old version.");
        console.error(e);
        run('sudo systemctl start fivem'); // Attempt to restart to prevent downtime
        process.exit(1);
    }

    // 4. Ensure permissions are correct
    log.info("Setting ownership for new files...");
    run(`sudo chown -R ${FIVEM_USER}:${FIVEM_USER} ${SERVER_DIR}`);

    // 5. Start the server
    log.info("Starting FiveM service...");
    run('sudo systemctl start fivem');

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    log.success(`Update complete in ${duration.toFixed(2)} seconds.`);
    console.log(`Check status with: ${chalk.bold('sudo systemctl status fivem')}`);
}

main().catch(err => console.error(err));
