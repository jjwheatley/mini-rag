import { readFileSync, writeFileSync } from "fs";

const newVersion = process.argv[2];

if (!newVersion) {
	console.error("Usage: node version-bump.mjs <version>  (e.g. 2.1.1)");
	process.exit(1);
}

if(!/^\d+\.\d+\.\d+$/.test(newVersion)){
	console.error(`Error: ${newVersion} is not a valid version. (e.g. 2.1.1)`);
	process.exit(1);
}

function isHigher(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] > pb[i]) return true;
		if (pa[i] < pb[i]) return false;
	}
	return false;
}

let pkg = JSON.parse(readFileSync("package.json", "utf8"));
const currentVersion = pkg.version;

if (!isHigher(newVersion, currentVersion)) {
	console.error(`Error: ${newVersion} is not higher than current version ${currentVersion}`);
	process.exit(1);
}

// Bump package.json
pkg.version = newVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, "\t"));

// Bump manifest.json
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = newVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// Update versions.json with new version and minAppVersion
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[newVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

console.log(`Bumped ${currentVersion} → ${newVersion}`);
