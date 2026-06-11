const puppeteer = require('puppeteer');

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on('console', msg => {
        console.log(`[PAGE LOG] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    page.on('request', request => {
        const url = request.url();
        if (url.includes('.vtt') || url.includes('sub') || url.includes('lostproject') || url.includes('megaplay') || url.includes('1oe')) {
            console.log(`[NETWORK REQ] ${request.method()} ${url}`);
        }
    });

    page.on('response', response => {
        const url = response.url();
        if (url.includes('.vtt') || url.includes('sub') || url.includes('lostproject') || url.includes('megaplay') || url.includes('1oe')) {
            console.log(`[NETWORK RESP] Status ${response.status()} for ${url}`);
        }
    });

    const url = 'https://anisuge.tv/watch/spirit-chronicles-ur0vs/ep-7';
    console.log(`Navigating to ${url}...`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Page loaded. Waiting 10 seconds...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log('Taking screenshot...');
        await page.screenshot({ path: 'anisuge_screenshot.png' });
        console.log('Screenshot saved as anisuge_screenshot.png');

        const html = await page.evaluate(() => document.body.innerHTML);
        console.log('HTML size:', html.length);
        console.log('Checking for iframe or player...');
        const hasIframe = html.includes('iframe');
        const hasPlayer = html.includes('player') || html.includes('video');
        console.log(`HTML checks: hasIframe=${hasIframe}, hasPlayer=${hasPlayer}`);

        const frames = page.frames();
        console.log(`Found ${frames.length} frames.`);
        frames.forEach((frame, i) => {
            console.log(`[Frame ${i}] name="${frame.name()}" url="${frame.url()}"`);
        });

    } catch (e) {
        console.error('Error during navigation:', e.message);
    }

    console.log('Closing browser...');
    await browser.close();
})();
