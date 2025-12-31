import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const PORT = 3000;

async function checkAndKillPort(port) {
  console.log(`[Port Check] Checking if port ${port} is in use...`);

  try {
    // Find process ID using lsof (works on macOS/Linux)
    // -t: terse mode (only PIDs)
    // -i: internet address
    const { stdout } = await execAsync(`lsof -ti:${port}`);
    
    if (stdout) {
      const pids = stdout.trim().split('\n');
      console.log(`[Port Check] Port ${port} is used by PID(s): ${pids.join(', ')}`);
      
      for (const pid of pids) {
        console.log(`[Port Check] Killing process ${pid}...`);
        await execAsync(`kill -9 ${pid}`);
      }
      
      console.log(`[Port Check] Port ${port} successfully released.`);
      
      // Give system a moment to fully release the port
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    // If lsof returns exit code 1, it means no process found, which is good
    if (error.code === 1) {
      console.log(`[Port Check] Port ${port} is free.`);
    } else {
      console.error(`[Port Check] Error checking port: ${error.message}`);
      // We don't exit here, we let Vite try to start and report error if it fails
    }
  }
}

checkAndKillPort(PORT);
