import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const iconScriptPath = path.join(__dirname, 'build-macos-app-icon.py')
const iconPngPath = path.join(rootDir, 'src-tauri', 'icons', 'icon.png')

function findPythonRunner() {
  const candidates = [
    { cmd: 'python3', args: [] },
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
    { cmd: 'py', args: [] },
  ]

  for (const { cmd, args } of candidates) {
    try {
      const res = spawnSync(
        cmd,
        [...args, '-c', 'from PIL import Image; print("OK")'],
        {
          cwd: rootDir,
          stdio: 'pipe',
          windowsHide: true,
        }
      )
      if (res.status === 0 && res.stdout.toString().includes('OK')) {
        return { cmd, args }
      }
    } catch {
      // Ignore and continue checking
    }
  }

  return null
}

function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`)
  }
}

function main() {
  const pyRunner = findPythonRunner()

  if (pyRunner) {
    console.log(`[build:icon] Preparing macOS icon using ${pyRunner.cmd}...`)
    runCommand(pyRunner.cmd, [...pyRunner.args, iconScriptPath])
  } else {
    if (fs.existsSync(iconPngPath)) {
      console.log(
        `[build:icon] Python with Pillow not found. Using existing ${iconPngPath}`
      )
    } else {
      console.error(
        `[build:icon] Error: ${iconPngPath} does not exist and Python with Pillow is not available to generate it.`
      )
      process.exit(1)
    }
  }

  console.log('[build:icon] Generating Tauri icons...')
  runCommand('yarn', ['tauri', 'icon', './src-tauri/icons/icon.png'])

  if (pyRunner) {
    console.log(`[build:icon] Finalizing macOS icon padding...`)
    runCommand(pyRunner.cmd, [...pyRunner.args, iconScriptPath])
  }

  console.log('[build:icon] Icon generation complete.')
}

main()
