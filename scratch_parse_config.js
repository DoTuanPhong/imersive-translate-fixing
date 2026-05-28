const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'immersive-translate-repo', 'dist', 'firefox', 'default_config.json');
try {
    const data = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(data);
    
    const rules = config.rules;
    
    // Find rules with ID common-vtt and common-vtt-jw
    for (const rule of Object.values(rules)) {
        if (rule.id === 'common-vtt' || rule.id === 'common-vtt-jw') {
            console.log('--------------------------------------------------');
            console.log(`Rule ID: ${rule.id}`);
            console.log(JSON.stringify(rule, null, 2));
        }
    }

} catch (e) {
    console.error('Error:', e.message);
}
