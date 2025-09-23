'use strict';

const http = require('http');
const url = require('url');
const fs = require('fs');
const ejs = require('ejs');
const path = require('path');
const cluster = require('cluster');
const cpu = require('os').cpus();
const { Configuration, OpenAIApi } = require("openai");

const root_dir = path.join(__dirname, '../');
const configFile = fs.readFileSync(root_dir + 'etc/config.json', 'UTF-8');
const mimeFile = fs.readFileSync(root_dir + 'etc/mime.json', 'UTF-8');
const statusFile = fs.readFileSync(root_dir + 'etc/status.json', 'UTF-8');
const statusEjs = fs.readFileSync(root_dir + 'etc/default_page/status.ejs', 'UTF-8');
const indexEjs = fs.readFileSync(root_dir + 'etc/default_page/index.ejs', 'UTF-8');

//default config value
let config = JSON.parse(configFile);
const mime_type = JSON.parse(mimeFile);
const status_code = JSON.parse(statusFile);
const os = process.platform;

//api value
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY || config['GPT']['key'] 
});

//config option
for (let i = 2; i < process.argv.length; i += 2) {
    let value = process.argv[i + 1];
    switch (process.argv[i]) {
        case '-p':
        case '--port':
            value = parseInt(value);
            if (value && 0 < value) {
                config['port'] = value;
            } else {
                console.log("invalid port number");
                process.exit(0);
            }
            break;
        case '-l':
        case '--log':
            value = String(value);
            if (value === 'on' || value === 'off') {
                config['LOG']['status'] = value;
            } else {
                console.log("log status value is on or off");
                process.exit(0);
            }
            break;     
        case '-s':
        case '--show':
            value = String(value);
            if(value === 'config'){
                console.log(JSON.stringify(config, null, '  '));
            }else if(value === 'define'){
                console.log(JSON.stringify(JSON.parse(fs.readFileSync(root_dir + 'etc/define.json', 'UTF-8'), null, '  ')));
            }else{
                console.log("show value is config, define");
            }
            process.exit(0);   
        case '-v':
        case '--version':
            if (config['version']) {
                console.log(config['version']);
            }else{
                console.log("version is not");
            }
            process.exit(0);
        default:
            console.log(`${config['title']} httpd.js options`);
            console.log("-p, --port [80 or 443 or 1024-65535]");
            console.log("-l, --log [log validate is on or off]");
            console.log("-s, --show [config, define]");
            console.log("-v, --version : version check");
            process.exit(0);
    }
}

//full path
if (!config['document_root']) config['document_root'] = root_dir + 'www';
if (!config['LOG']['dir']) config['LOG']['dir'] = root_dir + 'log';
const log_file = `${config['LOG']['dir']}/${config['LOG']['file']}`;

//cluster process
if (cluster.isMaster) {
    for (let i = 0; i < cpu.length; i++) {
        //Open browser
        if(i === 0 && config['browser'] && config['browser'] === 'on'){
            const url = `http://localhost:${config['port']}`;
            openBrowser(url);
        }

        cluster.fork({ msg: `ID${i}` })
            .on("message", msg => console.log(msg));
    }
} else {
    const port = parseInt(config['port']);
    const uid = process.getuid();
    const gid = process.getgroups();
    let server = http.createServer(RouteSetting);

    switch (port) {
        case 443:
            try {
                const SSL_AUTH = {
                    "key": fs.readFileSync(config['ssl_key_file'], 'UTF-8'),
                    "cert": fs.readFileSync(config['ssl_cert_file'], 'UTF-8')
                };
                const https = require('https');
                server = https.createServer(SSL_AUTH, RouteSetting);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    console.error("Can't read ssl files");
                } else {
                    console.error(`${err.name}:${err.code}`);
                }
                process.exit(-1);
            }
        case 80:
            if (process.env.PORT) {
                server.listen(process.env.PORT);
            } else {
                if (uid != 0 || gid[0] != 0) {
                    console.error("Not permission\nPlease root uid or root gid");
                    process.exit(-1);
                }
                if (!config['system_user']) {
                    console.log("Warnings!! Don's exists system_user from config file");
                }
                server.listen(port, function() {
                    process.setuid(config['system_user'] || 'root');
                });
            }
            break;
        default:
            if (typeof port !== "number" || port < 1024 || port > 65535) {
                console.log("port error [80 or 443 or 1024-65535]");
                process.exit(-1);
            }
            server.listen(process.env.PORT || port);
    }

    const msg = process.env.msg;
    process.send(`from worker (${msg})`);
    console.log(`PORT=${process.env.PORT || port}\n${config['title']} (${os}) running!`);
}

cluster.on('exit', function(worker, code, signal) {
    console.log('Worker %d died with code/signal %s. Restarting worker...', worker.process.pid, signal || code);
});

//request
function RouteSetting(req, res) {
    try {
        const urldata = url.parse(req.url, true);
        const extname = String(path.extname(urldata.pathname)).toLowerCase();
        const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',', 2)[0] : req.socket['remoteAddress'];
        const ua = req.headers['user-agent'];
        const pid = process.pid;
        const time = new Date().toISOString();
        const log_data = `[${time}] ${req.headers['host']} ${urldata.pathname} <= ${ip} ${ua} PID=${pid}\n`;
        let content_type = !extname ? 'text/html' : mime_type[extname] || 'text/plain';
        let encode = content_type.split('/', 2)[0] === 'text' ? 'UTF-8' : null;
        let code = 200;
        
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (config['CACHE']['status'] === "on") {
            res.setHeader('Pragma', 'cache');
            res.setHeader('Cache-Control', `max-age=${config['CACHE']['max_age']}`)
        }
        if (config['LOG']['status'] === "on") {
            fs.appendFile(log_file, log_data, function(err) {
                console.log(log_data);
                if (err) console.error("log write error");
            });
        }
        
        if(urldata.pathname == '/api'){ //api routing   
            let answer;
            content_type = 'application/json';
            if (req.method === 'OPTIONS') {
                code = 204;
                res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
                res.writeHead(code, {'Content-Type': content_type});
                return res.end();
            }
            
            if (req.method === 'POST') {
                const POST = [];
                let data = '';
                req.on('data', chunk => data += chunk)
                .on('end', async () => {
                    if (data && req.headers['content-type']) {
                        if(req.headers['content-type'].indexOf('application/x-www-form-urlencoded') !== -1){
                            decodeURIComponent(data).split('&').forEach(out => {
                                let key = out.split('=')[0].trim();
                                let value = out.split('=')[1].replace(/\+/g, ' ').trim();
                                POST[key] = value;
                            });
                        }else if(req.headers['content-type'].indexOf('application/json') !== -1){
                            const json = JSON.parse(data);
                            for(let key in json){
                                POST[key] = json[key];
                            }
                        }
                    }
                    answer = await gpt_render(POST);
                    code = answer ? 200 : 400;
                    res.writeHead(code, {'Content-Type': content_type});
                    res.end(answer);
                });
            } else {
                const GET = request_get(url.parse(req.url, true).search);
                (async () => {
                    answer = await gpt_render(GET);
                    code = answer ? 200 : 400;
                    res.writeHead(code, {'Content-Type': content_type});
                    res.end(answer);
                })();
            }
        }else{ //page routing
            const dir = String(config['document_root'] + urldata.pathname);
            fs.readdir(dir, function(err, files) {
                let file, page;
                let index = '';
                if (!err) { //dir
                    for (let get of files) {
                        if (get == 'index.ejs') {
                            index = get;
                            break;
                        }
                        if (get == 'index.html') {
                            index = get;
                        }
                    }
                    if (urldata.pathname.slice(-1) != '/') {
                        file = String(dir + '/' + index);
                    } else {
                        file = String(dir + index);
                    }
                    
                    fs.readFile(file, encode, function(err, data) {
                        if (!err) {
                            if (index == 'index.ejs') {
                                if (ejs_render(req, res, data)) return;
                                code = 400;
                                page = status_page(code);
                            } else {
                                page = data;
                            }
                        } else if (urldata.pathname == '/') { //top dir
                            page = ejs.render(indexEjs, { config, dir });
                        } else {
                            code = 403;
                            page = status_page(code);
                        }
                        
                        content_type = 'text/html';
                        res.writeHead(code, {'Content-Type': content_type});
                        res.end(page);
                    });
                } else { //not dir
                    file = dir;
                    fs.readFile(file, encode, function(err, data) {
                        if (!err) {
                            if (content_type == 'text/html' && extname == '.ejs') { //.ejs
                                if (ejs_render(req, res, data)) return;
                                code = 400;
                                page = status_page(code);
                            } else {
                                page = data;
                            }
                        } else if (err.code === 'ENOENT') { //not page
                            content_type = 'text/html';
                            code = 404;
                            page = status_page(code);
                        } else {
                            content_type = 'text/html';
                            code = 400;
                            page = status_page(code);
                        }
    
                        res.writeHead(code, {'Content-Type': content_type});
                        res.end(page);
                    });
                }
            });
        }
    } catch (e) {
        console.error(e.name);
        if (!res.headersSent) { 
            let error = `500 ${status_code['500']}`;
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(error);
        }
    }
}

async function openBrowser(url) {
    const { default: open } = await import("open");
    open(url).catch(err => {
    console.error("ブラウザを開けませんでした:", err);
    });
}

async function gpt_render(REQUEST){
    let answer = {reply: ""};
    const modify = "\n以上の内容でHTMLとCSSを一つにまとめてコードを出力してください。コード以外の説明は不要です。";
    try {
        if(REQUEST && REQUEST['message']){
            const question = REQUEST['message'] + modify;
            const history = REQUEST['html'] && REQUEST['css'] ? `HTML:\n${REQUEST['html']}\n\nCSS:\n${REQUEST['css']}\n\n` : "";
            const openai = new OpenAIApi(configuration);
            const completion = await openai.createChatCompletion({
                model: config['GPT']['model'],
                messages: [
                    { role: "system", content: "あなた優秀なHTML/CSSコーダーです。履歴のコードをもとに上手に修正する事もできます。" },
                    { role: "user", content: question },
                    { role: "assistant", content: history }
                ],
                temperature: config['GPT']['temperature'] || 0.7,
            });
            answer['reply'] = completion.data.choices[0].message.content;
        }
        return JSON.stringify(answer); 
    }catch(e){
        console.log("gpt api error");
        return JSON.stringify(new Object());
    }
}

function ejs_render(req, res, page) {
   try {
        const COOKIE = sanitizeObject(get_cookie(req.headers['cookie']));
        const DEFINE = JSON.parse(fs.readFileSync(root_dir + 'etc/define.json', 'UTF-8'));
        DEFINE['response'] = res;
        DEFINE['gpt_port'] = config['GPT']['port'];
        
        const locals = {
            COOKIE, DEFINE
        };

        page = ejs.render(page, locals);
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(page);
        return true;
    } catch (e) {
        console.error(e.name);
        return false;
    }
}

function request_get(data) {
    try {
        const array = [];
        if (data) {
            data = decodeURIComponent(data).split('?')[1];
            if (data) {
                data.split('&').forEach(function(out) {
                    let key = out.split('=')[0].trim();
                    let value = out.split('=')[1].trim();
                    array[key] = value;
                });
            }
        }
        return array;
    } catch (e) {
        console.error(e.name);
        return [];
    }
}

function get_cookie(data) {
    try {
        const array = [];
        if (data) {
            decodeURIComponent(data).split(';').forEach(function(out) {
                let key = out.split('=')[0].trim();
                let value = out.split('=')[1].trim();
                array[key] = value;
            });
        }
        return array;
    } catch (e) {
        console.error(e.name);
        return [];
    }
}

function status_page(code) {
    code = String(code);
    for (let i in status_code) {
        if (i === code) {
            return ejs.render(statusEjs, {
                config,
                'STATUS': `${code} ${status_code[code]}`
            });
        }
    }
    return null;
}

function sanitizeObject(obj) {
    const out = {};
    for (let key in obj) {
        out[key] = escapeHTML(obj[key]);
    }
    return out;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
