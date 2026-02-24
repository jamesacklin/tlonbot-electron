// electron-builder afterPack hook
// Ensures tlon-plugin dependencies are installed in the packaged app

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

exports.default = async function (context) {
  const pluginDir = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "tlon-plugin"
  );

  if (fs.existsSync(pluginDir) && fs.existsSync(path.join(pluginDir, "package.json"))) {
    console.log("Installing tlon-plugin production dependencies...");
    execSync("npm install --production", {
      cwd: pluginDir,
      stdio: "inherit",
    });
    console.log("tlon-plugin dependencies installed.");
  } else {
    console.log("No tlon-plugin found in resources, skipping dependency install.");
  }
};
