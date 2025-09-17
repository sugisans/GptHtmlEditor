# gpt html editor

Execute = $node bin/app.js

Default access = http://localhost:3000

Default api access = http://localhost:8080

Setting file = ./etc/config.json

App page file = ./www/index.ejs

Set up gpt key to ./etc/config.json
        "GPT": {
                "port": 8080,                   //set to API port
                "temperature": 0.7,             //set to temperature
                "model": "gpt-4.1-mini",        //set to gpt model
                "key": ""                       //set to API key
        },

