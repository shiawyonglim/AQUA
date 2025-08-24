// pythonHelper.js
const { spawn } = require("child_process");

function getTifValue(lon, lat) {
    return new Promise((resolve, reject) => {
        const python = spawn("python", ["call.py", lon, lat]);

        let result = "";
        let errorMsg = "";

        python.stdout.on("data", (data) => {
            result += data.toString();
        });

        python.stderr.on("data", (data) => {
            errorMsg += data.toString();
        });

        python.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Python exited with code ${code}: ${errorMsg}`));
            } else {
                resolve(parseFloat(result.trim())); // return numeric GeoTIFF value
            }
        });
    });
}

module.exports = { getTifValue };
