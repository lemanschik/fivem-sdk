#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const readline = require('readline');

// --- Configuration ---
const FIVEM_USER = "fivem";
const BASE_DIR = `/home/${FIVEM_USER}`;
const SERVER_DIR = `${BASE_DIR}/server`;
const DATA_DIR = `${BASE_DIR}/server-data`;
const LATEST_URL = "https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/";

// --- Helper Functions ---
const log = {
    info: (msg) => console.log(chalk.blue.bold(`[INFO] `) + msg),
    success: (msg) => console.log(chalk.green.bold(`[SUCCESS] `) + msg),
    warn: (msg) => console.log(chalk.yellow.bold(`[WARN] `) + msg),
    error: (msg) => console.log(chalk.red.bold(`[ERROR] `) + msg),
    step: (msg) => console.log(chalk.cyan.bold(`\n--- ${msg} ---`))
};

const run = (command, ignoreError = false) => {
    try {
        log.info(`Executing: ${command}`);
        execSync(command, { stdio: 'inherit' });
    } catch (e) {
        if (!ignoreError) {
            log.error(`Command failed: ${command}`);
            process.exit(1);
        } else {
            log.warn(`Command failed but was ignored: ${command}`);
        }
    }
};

const askQuestion = (query) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

// --- Main Deployment Logic ---
async function main() {
    console.log(chalk.magenta.bold("### FiveM Server NodeJS Deployment Script ###"));

    // 1. Check if running as root
    if (process.getuid() !== 0) {
        log.error("This script must be run as root. Please use 'sudo node deploy_fivem.js'.");
        process.exit(1);
    }

    // 2. Create a dedicated user
    log.step("Step 1: Creating dedicated user");
    try {
        execSync(`id "${FIVEM_USER}"`);
        log.warn(`User '${FIVEM_USER}' already exists. Skipping creation.`);
    } catch (e) {
        run(`useradd -r -m -d "${BASE_DIR}" -s /bin/bash "${FIVEM_USER}"`);
        log.success(`User '${FIVEM_USER}' created.`);
    }

    // 3. Create directory structure
    log.step("Step 2: Creating directory structure");
    if (!fs.existsSync(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    log.success(`Directories created: ${SERVER_DIR} and ${DATA_DIR}`);

    // 4. Download and Extract FXServer
    log.step("Step 3: Downloading and installing FXServer");
    try {
        log.info("Finding latest FXServer build...");
        const response = await axios.get(LATEST_URL);
        const latestBuild = response.data.match(/href="([0-9-a-f]{40,}\/)"/)[1];
        const downloadUrl = `${LATEST_URL}${latestBuild}fx.tar.xz`;
        const downloadPath = path.join(SERVER_DIR, 'fx.tar.xz');

        log.info(`Downloading from ${downloadUrl}`);
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

        log.success("Download complete. Extracting...");
        run(`tar -xJf ${downloadPath} -C ${SERVER_DIR}`);
        fs.unlinkSync(downloadPath); // Clean up archive
        log.success("FXServer extracted.");

    } catch (e) {
        log.error("Failed to download or extract FXServer.");
        console.error(e);
        process.exit(1);
    }

    // 5. Clone cfx-server-data
    log.step("Step 4: Cloning cfx-server-data");
    if (fs.readdirSync(DATA_DIR).length === 0) {
        run(`git clone https://github.com/citizenfx/cfx-server-data.git ${DATA_DIR}`);
        log.success("cfx-server-data cloned.");
    } else {
        log.warn("server-data directory is not empty. Skipping clone.");
    }

    // 6. Create server.cfg and start script
    log.step("Step 5: Creating configuration files");
    const serverCfgContent = `
# FiveM server.cfg - A basic configuration
# Get a license key from https://keymaster.fivem.net
sv_licenseKey "CHANGE_ME"

# Set your server's hostname
sv_hostname "My Awesome FiveM Server (NodeJS Deployed)"

# Server endpoint configuration
endpoint_add_tcp "0.0.0.0:30120"
endpoint_add_udp "0.0.0.0:30120"

# Add system admins (e.g., steam:xxxxxxxxxxxxxxxxx)
add_ace group.admin command allow
add_ace group.admin command.quit deny
# add_principal identifier.steam:110000100000000 group.admin

# Resources to start
ensure mapmanager
ensure chat
ensure spawnmanager
ensure sessionmanager
ensure basic-gamemode
ensure hardcap
ensure rconlog
`;
    fs.writeFileSync(path.join(DATA_DIR, 'server.cfg'), serverCfgContent);

    const startShContent = `#!/bin/bash
cd ${DATA_DIR} || exit
${SERVER_DIR}/run.sh +exec server.cfg
`;
    const startScriptPath = path.join(BASE_DIR, 'start.sh');
    fs.writeFileSync(startScriptPath, startShContent);
    fs.chmodSync(startScriptPath, '755');
    log.success("server.cfg and start.sh created.");

    // 7. Set permissions
    log.step("Step 6: Setting ownership");
    run(`chown -R ${FIVEM_USER}:${FIVEM_USER} ${BASE_DIR}`);
    log.success(`Ownership of ${BASE_DIR} set to ${FIVEM_USER}.`);

    // 8. Create and enable systemd service
    log.step("Step 7: Creating systemd service");
    const serviceContent = `
[Unit]
Description=FiveM Server
After=network.target

[Service]
Type=simple
User=${FIVEM_USER}
Group=${FIVEM_USER}
WorkingDirectory=${DATA_DIR}
ExecStart=${startScriptPath}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync('/etc/systemd/system/fivem.service', serviceContent);
    run('systemctl daemon-reload');
    run('systemctl enable fivem.service');
    log.success("Systemd service 'fivem.service' created and enabled.");

    // 9. Configure Firewall
    log.step("Step 8: Configuring Firewall (UFW)");
    run('ufw allow 30120/tcp');
    run('ufw allow 30120/udp');
    const answer = await askQuestion(chalk.yellow.bold("[ACTION] ") + "Enable the firewall (UFW)? This may disconnect your SSH session if port 22 is not allowed. (y/N): ");
    if (answer.toLowerCase() === 'y') {
        run('ufw --force enable');
        log.success("Firewall enabled.");
    } else {
        log.warn("Firewall not enabled. Please configure it manually with 'sudo ufw enable'.");
    }
    run('ufw status');


    // --- Final Instructions ---
    console.log(chalk.green.bold("\n-----------------------------------------------------"));
    console.log(chalk.green.bold("### FiveM Server Deployment Complete! ###\n"));
    log.warn("!!! IMPORTANT NEXT STEPS !!!");
    console.log(`1. Edit your server configuration: ${chalk.bold(`sudo nano ${DATA_DIR}/server.cfg`)}`);
    console.log(`2. GET A LICENSE KEY from ${chalk.underline('https://keymaster.fivem.net')} and add it to server.cfg.`);
    console.log("\nTo manage your server, use these commands:");
    console.log(` - Start server:   ${chalk.bold('sudo systemctl start fivem')}`);
    console.log(` - Stop server:    ${chalk.bold('sudo systemctl stop fivem')}`);
    console.log(` - View status:    ${chalk.bold('sudo systemctl status fivem')}`);
    console.log(` - View live log:  ${chalk.bold('sudo journalctl -fu fivem.service')}`);
    console.log(chalk.green.bold("\n-----------------------------------------------------"));
}

main().catch(err => log.error(err));
