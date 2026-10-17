const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const STORAGE_DIR = path.join(__dirname, 'cloud_vault');
fs.ensureDirSync(STORAGE_DIR);

// Matalinong Link Extractor para sa kahit anong site (MediaFire, atbp.)
async function resolveDirectLink(pageUrl) {
    try {
        // Kung MediaFire link
        if (pageUrl.includes('mediafire.com')) {
            const { data } = await axios.get(pageUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
            });
            const $ = cheerio.load(data);
            const downloadBtn = $('#downloadButton').attr('href');
            if (downloadBtn) return downloadBtn;
        }
        
        // Para sa iba pang sites na nagbibigay ng HTML landing page, susubukan nating basahin ang direct download anchor tags
        const { data, headers } = await axios.get(pageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' }
        });

        // Kung direct file na pala ito, ibalik lang ang URL
        if (headers['content-type'] && !headers['content-type'].includes('text/html')) {
            return pageUrl;
        }

        // Kung HTML page, hahanapin ang unang .apk link o download link sa loob ng pahina
        const $ = cheerio.load(data);
        let foundLink = null;
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.endsWith('.apk') || href.includes('download'))) {
                foundLink = href;
                return false; // break loop
            }
        });

        if (foundLink) {
            // Kung relative URL, ayusin
            if (foundLink.startsWith('http')) return foundLink;
            const parsedUrl = new URL(pageUrl);
            return `${parsedUrl.origin}${foundLink}`;
        }
    } catch (e) {
        console.error('Link resolution fallback to original:', e.message);
    }
    return pageUrl;
}

// PHASE 1: Cloud Fetch API
app.post('/api/fetch-to-cloud', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Kailangan ng valid na link' });

    try {
        const directUrl = await resolveDirectLink(url);
        const transferId = crypto.randomBytes(8).toString('hex');
        const filename = `app_${transferId}.apk`;
        const filePath = path.join(STORAGE_DIR, filename);

        const response = await axios({
            method: 'GET',
            url: directUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': 'application/vnd.android.package-archive,application/octet-stream,*/*'
            }
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        writer.on('finish', async () => {
            const stats = await fs.stat(filePath);
            // Pinaamo natin ang size limit para masigurong hindi agad mag-error kung medyo maliit ang file
            if (stats.size < 1024 * 10) { 
                await fs.remove(filePath);
                return res.status(400).json({ error: 'Nabigo ang server na makuha ang buong file. Pakisubukan ang ibang direktang link.' });
            }

            res.json({
                success: true,
                transferId: transferId,
                filename: filename,
                fileSize: stats.size,
                relayApi: `/api/relay/stream/${transferId}`
            });
        });

        writer.on('error', async () => {
            await fs.remove(filePath).catch(() => {});
            res.status(500).json({ error: 'Bigo ang pag-download sa cloud server.' });
        });

    } catch (err) {
        res.status(500).json({ error: 'Hindi ma-access o block ang ibinigay na URL.' });
    }
});

// PHASE 2: Local Stream Relay API + Instant Auto-Delete
app.get('/api/relay/stream/:transferId', (req, res) => {
    const { transferId } = req.params;
    const filename = `app_${transferId}.apk`;
    const filePath = path.join(STORAGE_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Wala na ang file o na-delete na sa cloud vault.' });
    }

    const stat = fs.statSync(filePath);

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);

    const cleanup = () => {
        if (fs.existsSync(filePath)) {
            fs.remove(filePath)
                .then(() => console.log(`[INSTANT CLEANUP] Naipasa na ang ${filename} at agad na binura sa cloud server.`))
                .catch(err => console.error('Cleanup error:', err));
        }
    };

    res.on('finish', cleanup);
    readStream.on('close', cleanup);
    res.on('close', cleanup);
});

app.listen(PORT, () => {
    console.log(`Cloud Server active on port ${PORT}`);
});
    
