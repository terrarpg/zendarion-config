const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const app = express();
const port = process.env.PORT || 3000;

// --- Configuration CORS ---
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    next();
});

// --- 1. Route Principale : Liste des fichiers (RETOURNE UN TABLEAU) ---
app.get('/files/', (req, res) => {
    const instanceName = req.query.instance;
    if (!instanceName) return res.json([]); // Retourne un tableau vide

    const instancePath = path.join(__dirname, 'files', 'instances', instanceName);
    console.log(`🔍 Scan de l'instance: "${instanceName}"`);

    if (!fs.existsSync(instancePath)) {
        console.log(`❌ Instance non trouvée.`);
        return res.json([]);
    }

    function scanDirectory(dir, basePath = '') {
        const results = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relativePath = basePath ? `${basePath}/${item}` : item;

                try {
                    const stats = fs.statSync(fullPath);

                    if (stats.isDirectory()) {
                        // Scanner récursivement les sous-dossiers
                        results.push(...scanDirectory(fullPath, relativePath));
                    } else {
                        // IGNORE les fichiers temporaires .x et JNA
                        if (item.endsWith('.x') || (item.startsWith('jna') && item.includes('.dll'))) {
                            console.log(`   ⚠️ Ignoré (fichier temp): ${relativePath}`);
                            continue;
                        }

                        let fileUrl;
                        // Détection d'un hash SHA1 (Asset Minecraft)
                        if (item.length === 40 && /^[0-9a-f]{40}$/.test(item) && relativePath.includes('assets/objects/')) {
                            const prefix = item.substring(0, 2);
                            fileUrl = `https://resources.download.minecraft.net/${prefix}/${item}`; // URL Mojang
                        } else {
                            // Pour tous les autres fichiers (libs, configs, mods...)
                            fileUrl = `https://${req.get('host')}/files/instances/${instanceName}/${relativePath.replace(/\\/g, '/')}`;
                        }

                        results.push({
                            name: item,
                            path: relativePath.replace(/\\/g, '/'),
                            size: stats.size,
                            url: fileUrl,
                            type: 'file',
                            modified: stats.mtime.toISOString()
                        });
                    }
                } catch (err) { /* Ignorer les erreurs de fichier individuel */ }
            }
        } catch (err) { /* Ignorer les erreurs de dossier */ }
        return results;
    }

    try {
        const fileList = scanDirectory(instancePath);
        console.log(`✅ ${fileList.length} fichiers valides listés.`);
        res.json(fileList); // CRITIQUE : Retourne directement le tableau.
    } catch (error) {
        console.error('❌ Erreur lors du scan:', error);
        res.status(500).json([]);
    }
});

// --- 2. Route de Téléchargement Intelligent avec Fallback ---
app.get('/files/instances/:instance/*', (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    const fullLocalPath = path.join(__dirname, 'files', 'instances', instanceName, filePath);
    const filename = path.basename(filePath);

    console.log(`📥 Demande: /${filePath}`);

    // STRATÉGIE : Gestion des fichiers temporaires (.x)
    if (filename.endsWith('.x') || (filename.startsWith('jna') && filename.includes('.dll'))) {
        console.log(`   🛡️  Fichier temporaire détecté. Réponse avec placeholder vide.`);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' });
        return res.end();
    }

    const isMinecraftAsset = filename.length === 40 && /^[0-9a-f]{40}$/.test(filename) && filePath.includes('assets/objects/');
    const isLikelyNative = filePath.includes('/natives/') && (filename.endsWith('.dll') || filename.endsWith('.so') || filename.endsWith('.dylib'));

    // Étape 1 : Servir depuis le système de fichiers local
    if (fs.existsSync(fullLocalPath)) {
        const stats = fs.statSync(fullLocalPath);
        if (stats.size > 0) {
            console.log(`   ✅ Servi depuis le cache local (${stats.size} octets).`);
            return res.sendFile(fullLocalPath);
        }
    }

    // Étape 2 : Pour les assets Minecraft, proxy vers Mojang
    if (isMinecraftAsset) {
        const prefix = filename.substring(0, 2);
        const mojangUrl = `https://resources.download.minecraft.net/${prefix}/${filename}`;
        console.log(`   🌐 Proxy vers Mojang: ${mojangUrl}`);

        const reqToMojang = https.get(mojangUrl, (mojangRes) => {
            if (mojangRes.statusCode === 200) {
                // 1. Streamer la réponse au client
                res.writeHead(200, {
                    'Content-Type': mojangRes.headers['content-type'] || 'application/octet-stream',
                    'Content-Length': mojangRes.headers['content-length']
                });
                mojangRes.pipe(res);

                // 2. Sauvegarder en cache pour la prochaine fois
                const dir = path.dirname(fullLocalPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const fileStream = fs.createWriteStream(fullLocalPath);
                mojangRes.pipe(fileStream);
                fileStream.on('finish', () => {
                    console.log(`   💾 Asset sauvegardé en cache: ${filename}`);
                    fileStream.close();
                });
            } else {
                console.log(`   ❌ Mojang a répondu ${mojangRes.statusCode}.`);
                sendNotFound(res, filePath);
            }
        });
        reqToMojang.on('error', (err) => {
            console.log(`   ❌ Échec de la connexion à Mojang: ${err.message}`);
            sendNotFound(res, filePath);
        });
        reqToMojang.setTimeout(10000, () => {
            console.log(`   ⏱️  Timeout sur la requête à Mojang.`);
            reqToMojang.destroy();
            sendNotFound(res, filePath);
        });
        return;
    }

    // Étape 3 : Pour les natives manquantes, créer un placeholder
    if (isLikelyNative) {
        console.log(`   🛠️  Création d'un placeholder pour la native: ${filename}`);
        const dir = path.dirname(fullLocalPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullLocalPath, ''); // Fichier vide
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' });
        return res.end();
    }

    // Étape 4 : Fichier introuvable partout
    console.log(`   ❌ Fichier introuvable.`);
    sendNotFound(res, filePath);
});

// --- 3. Routes Utilitaires (Check, Prefetch, Nettoyage) ---
app.get('/check-file/:hash', (req, res) => {
    const hash = req.params.hash;
    const prefix = hash.substring(0, 2);
    const localPath = path.join(__dirname, 'files', 'instances', 'zendariom', 'assets', 'objects', prefix, hash);
    const exists = fs.existsSync(localPath);
    res.json({
        hash,
        exists_locally: exists,
        local_path: localPath,
        mojang_url: `https://resources.download.minecraft.net/${prefix}/${hash}`,
        your_server_url: `https://${req.get('host')}/files/instances/zendariom/assets/objects/${prefix}/${hash}`
    });
});

app.get('/prefetch-assets', async (req, res) => {
    const instance = req.query.instance || 'zendariom';
    const specific = req.query.assets ? req.query.assets.split(',') : [
        '5cca35534cc2ee3529d39b7ccc12b437955e0683',
        '5df4a02b1ebc550514841fddb7d64b9c497d40b4'
    ];
    console.log(`🔄 Pré-téléchargement demandé pour ${instance}`);

    const results = [];
    for (const asset of specific) {
        const prefix = asset.substring(0, 2);
        const localPath = path.join(__dirname, 'files', 'instances', instance, 'assets', 'objects', prefix, asset);
        if (fs.existsSync(localPath)) {
            results.push({ asset, status: 'déjà présent' });
            continue;
        }
        const success = await downloadFromMojang(asset, localPath);
        results.push({ asset, status: success ? 'téléchargé' : 'échec' });
        await new Promise(r => setTimeout(r, 100)); // Pause
    }
    res.json({ instance, results });
});

app.get('/clean-temp-files', (req, res) => {
    const instance = req.query.instance || 'zendariom';
    const instancePath = path.join(__dirname, 'files', 'instances', instance);
    const deleted = [];
    function cleanDir(dir) {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                cleanDir(full);
                if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
            } else if (item.endsWith('.x') || (item.startsWith('jna') && item.includes('.dll'))) {
                fs.unlinkSync(full);
                deleted.push(path.relative(instancePath, full));
            }
        }
    }
    cleanDir(instancePath);
    res.json({ message: 'Nettoyage terminé.', fichiers_supprimés: deleted });
});

// --- 4. Route Racine (Page d'Accueil) ---
app.get('/', (req, res) => {
    const host = req.get('host');
    res.json({
        server: "Terra File Server - Zendarion",
        features: [
            "📁 Liste des fichiers: /files?instance=zendariom",
            "📦 Proxy auto vers Mojang pour assets manquants",
            "🔍 Vérifier un fichier: /check-file/HASH",
            "🔄 Pré-télécharger: /prefetch-assets?instance=zendariom",
            "🧹 Nettoyer fichiers .x: /clean-temp-files?instance=zendariom"
        ],
        example: {
            liste_fichiers: `https://${host}/files?instance=zendariom`,
            check_probleme: `https://${host}/check-file/5cca35534cc2ee3529d39b7ccc12b437955e0683`,
            prefetch: `https://${host}/prefetch-assets?instance=zendariom`
        },
        note: "Les assets Minecraft manquants sont automatiquement téléchargés depuis resources.download.minecraft.net et mis en cache."
    });
});

// --- Fonctions Helper ---
function sendNotFound(res, filePath) {
    res.status(404).json({
        error: 'Fichier non trouvé',
        path: filePath,
        suggestion: 'Le fichier est absent du serveur local et ne peut être récupéré depuis une source externe.'
    });
}

function downloadFromMojang(hash, outputPath) {
    return new Promise((resolve) => {
        const prefix = hash.substring(0, 2);
        const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fileStream = fs.createWriteStream(outputPath);
        const request = https.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log(`   ✅ Pré-téléchargé: ${hash}`);
                    resolve(true);
                });
            } else {
                fileStream.close();
                fs.unlink(outputPath, () => {});
                console.log(`   ❌ Échec du pré-téléchargement (${response.statusCode}): ${hash}`);
                resolve(false);
            }
        });
        request.on('error', () => {
            fileStream.close();
            fs.unlink(outputPath, () => {});
            resolve(false);
        });
        request.setTimeout(10000, () => {
            request.destroy();
            fileStream.close();
            fs.unlink(outputPath, () => {});
            resolve(false);
        });
    });
}

// --- Démarrage du Serveur ---
app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        Serveur Zendarion Config - Opérationnel              ║
╚══════════════════════════════════════════════════════════════╝
📡  Port: ${port}
🌐  URL: https://zendarion-config.onrender.com
🎯  Format de réponse: TABLEAU [] (compatible minecraft-java-core)
🛡️  Gestion des fichiers .x/jna : Placeholder automatique
🔀  Fallback Assets : Proxy vers Mojang activé
`);
    // Vérification rapide de la structure
    const instancesPath = path.join(__dirname, 'files', 'instances');
    if (!fs.existsSync(instancesPath)) {
        fs.mkdirSync(instancesPath, { recursive: true });
        console.log(`📁  Dossier 'instances' créé.`);
    }
});
