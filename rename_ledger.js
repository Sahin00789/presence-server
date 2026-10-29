const fs = require('fs');
const path = require('path');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && full.endsWith('.ts')) {
      let content = fs.readFileSync(full, 'utf8');
      if (content.includes('staffEarningLedger')) {
        content = content.replace(/staffEarningLedger/g, 'employeeEarningLedger');
        fs.writeFileSync(full, content);
        console.log('updated', full);
      }
    }
  }
}

walk(path.join(__dirname, 'src'));
console.log('done');
