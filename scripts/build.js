const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const { execSync } = require('child_process');

const DIST = path.join(process.cwd(), 'dist');
const MANIFEST = 'manifest.json';
const FOLDERS = ['icons', 'lib', 'src'];

// Function to copy shared files
function copySharedFiles() {
  const folders = FOLDERS.map((folder) => path.join('..', folder)).join(' ');
  execSync(`cd ${DIST} && cp -r ${folders} .`, { stdio: 'ignore' });
}

// Function to create a zip file
function createZip(zipFileName, manifest) {
  fs.writeFileSync(path.join(DIST, MANIFEST), JSON.stringify(manifest, null, 2));

  const folders = FOLDERS.map((folder) => path.join(folder, '*')).join(' ');
  execSync(`cd ${DIST} && zip -r ${zipFileName} ${MANIFEST} ${folders}`, {
    stdio: 'ignore',
  });
}

// Function to clean up the dist folder
function cleanUp() {
  const folders = FOLDERS.map((folder) => path.join(DIST, folder)).join(' ');
  execSync(`cd ${DIST} && rm -rf ${MANIFEST} ${folders}`, { stdio: 'ignore' });
}

// Function to remove [DEV] suffix from name if present
function getProductionName(name) {
  return name.replace(/\s*\[DEV\]\s*$/, '').trim();
}

// Read the original manifest file
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const { version } = manifest;

// Generate zip filenames
const chromeZip = `${version}-chrome.zip`;
const firefoxZip = `${version}-firefox.zip`;
const chromeUnzipped = path.join(DIST, `${version}-chrome`);

// Set up the CLI options (kept for future options)
program.parse(process.argv);

// make sure dist folder exists, if not create it
if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST);
}

// Remove existing zips (force by default)
if (fs.existsSync(path.join(DIST, chromeZip))) {
  fs.rmSync(path.join(DIST, chromeZip));
}

if (fs.existsSync(path.join(DIST, firefoxZip))) {
  fs.rmSync(path.join(DIST, firefoxZip));
}

// Remove existing unzipped Chrome folder
if (fs.existsSync(chromeUnzipped)) {
  fs.rmSync(chromeUnzipped, { recursive: true, force: true });
}

// Copy shared files to dist folder
copySharedFiles();

// Create Chrome build (remove [DEV] from name)
const manifestChrome = {
  ...manifest,
  name: getProductionName(manifest.name),
};
createZip(chromeZip, manifestChrome);

// Create Firefox build (remove [DEV] from name)
const manifestFirefox = Object.fromEntries(
  Object.entries({
    ...manifest,
    ...JSON.parse(fs.readFileSync('manifest-firefox.json', 'utf-8')),
  }).filter(([, value]) => value !== null)
);
manifestFirefox.name = getProductionName(manifest.name);
createZip(firefoxZip, manifestFirefox);

// Unzip Chrome version
execSync(`cd ${DIST} && unzip -q ${chromeZip} -d ${version}-chrome`, {
  stdio: 'ignore',
});

// Clean up dist folder
cleanUp();

console.log(`Chrome and Firefox v${version} builds created successfully!`);
console.log(`Chrome build unzipped to: dist/${version}-chrome`);
