import type { PythonStart } from "../../../src/build/python-detect.ts";

export interface PythonProjectCase {
  name: string;
  files: Record<string, string>;
  expected: PythonStart;
}

const FLASK_HELLO = `from flask import Flask

app = Flask(__name__)


@app.route("/")
def hello_world():
    return "<p>Hello, World!</p>"
`;

const FASTAPI_HELLO = `from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def read_root():
    return {"Hello": "World"}
`;

const DJANGO_MANAGE = (settings: string) =>
  `#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys


def main():
    """Run administrative tasks."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "${settings}")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError("Couldn't import Django.") from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`;

const DJANGO_WSGI = (pkg: string) =>
  `import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "${pkg}.settings")

application = get_wsgi_application()
`;

const DJANGO_ASGI = (pkg: string) =>
  `import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "${pkg}.settings")

application = get_asgi_application()
`;

const MYSITE = {
  "manage.py": DJANGO_MANAGE("mysite.settings"),
  "mysite/__init__.py": "",
  "mysite/settings.py": "",
  "mysite/urls.py": "",
  "mysite/wsgi.py": DJANGO_WSGI("mysite"),
  "mysite/asgi.py": DJANGO_ASGI("mysite"),
  "polls/__init__.py": "",
  "polls/views.py": "",
  "polls/models.py": "",
};

export const PYTHON_PROJECT_CORPUS: PythonProjectCase[] = [
  {
    name: "flask tutorial flaskr (factory package, pyproject)",
    files: {
      "pyproject.toml": `[project]
name = "flaskr"
version = "1.0.0"
description = "The basic blog app built in the Flask tutorial."
dependencies = [
    "flask",
]

[build-system]
requires = ["flit_core<4"]
build-backend = "flit_core.buildapi"
`,
      "flaskr/__init__.py": `import os

from flask import Flask


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(SECRET_KEY="dev")
    from . import db
    db.init_app(app)
    return app
`,
      "flaskr/db.py": "",
      "flaskr/auth.py": "",
      "flaskr/blog.py": "",
      "tests/conftest.py": "",
    },
    expected: {
      framework: "flask",
      startCommand: "flask --app flaskr run --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "flask quickstart hello",
    files: { "app.py": FLASK_HELLO, "requirements.txt": "flask\n" },
    expected: {
      framework: "flask",
      startCommand: "flask --app app run --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "flask heroku-style with gunicorn pinned",
    files: {
      "app.py": FLASK_HELLO,
      "requirements.txt": "Flask==3.0.3\ngunicorn==22.0.0\n",
    },
    expected: {
      framework: "flask",
      startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "flask factory with wsgi.py and gunicorn",
    files: {
      "app/__init__.py": `from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def create_app(config_class="config.Config"):
    app = Flask(__name__)
    app.config.from_object(config_class)
    db.init_app(app)
    return app
`,
      "app/routes.py": "",
      "config.py": `import os


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY") or "you-will-never-guess"
`,
      "wsgi.py": "from app import create_app\n\napp = create_app()\n",
      "requirements.txt":
        "Flask==3.0.0\nFlask-SQLAlchemy==3.1.1\ngunicorn==21.2.0\npsycopg2-binary\n",
    },
    expected: {
      framework: "flask",
      startCommand: "gunicorn wsgi:app --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "flask on elastic beanstalk (application.py)",
    files: {
      "application.py": `from flask import Flask

application = Flask(__name__)


@application.route("/")
def index():
    return "ok"


if __name__ == "__main__":
    application.run()
`,
      "requirements.txt": "flask\n",
    },
    expected: {
      framework: "flask",
      startCommand:
        "flask --app application:application run --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "flask that runs itself on $PORT",
    files: {
      "app.py": `import os

from flask import Flask

app = Flask(__name__)


@app.route("/")
def index():
    return "hi"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
`,
      "requirements.txt": "flask\nrequests\n",
    },
    expected: {
      framework: "flask",
      startCommand: "python app.py",
    },
  },
  {
    name: "flask-socketio chat",
    files: {
      "app.py": `import os

from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__)
socketio = SocketIO(app)

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
`,
      "requirements.txt": "flask\nflask-socketio\neventlet\n",
    },
    expected: {
      framework: "flask",
      startCommand: "python app.py",
    },
  },
  {
    name: "flask with pipenv",
    files: {
      "app.py": FLASK_HELLO,
      "Pipfile": `[[source]]
url = "https://pypi.org/simple"
verify_ssl = true
name = "pypi"

[packages]
flask = "*"
gunicorn = "*"

[dev-packages]
pytest = "*"

[requires]
python_version = "3.11"
`,
      "Pipfile.lock": "",
    },
    expected: {
      framework: "flask",
      startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "flask with uv project",
    files: {
      "main.py": FLASK_HELLO,
      "pyproject.toml": `[project]
name = "web"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "flask>=3.1.0",
    "gunicorn>=23.0.0",
]
`,
      "uv.lock": "",
      ".python-version": "3.12\n",
    },
    expected: {
      framework: "flask",
      startCommand: "gunicorn main:app --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "fastapi quickstart with uvicorn",
    files: {
      "main.py": FASTAPI_HELLO,
      "requirements.txt": "fastapi\nuvicorn[standard]\n",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi standard extra only",
    files: {
      "main.py": FASTAPI_HELLO,
      "requirements.txt": "fastapi[standard]>=0.115.0\n",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi without a declared server",
    files: { "main.py": FASTAPI_HELLO, "requirements.txt": "fastapi\n" },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "full-stack-fastapi-template backend",
    files: {
      "pyproject.toml": `[project]
name = "app"
version = "0.1.0"
description = ""
requires-python = ">=3.10,<4.0"
dependencies = [
    "fastapi[standard]<1.0.0,>=0.114.2",
    "python-multipart<1.0.0,>=0.0.7",
    "email-validator<3.0.0.0,>=2.1.0.post1",
    "passlib[bcrypt]<2.0.0,>=1.7.4",
    "tenacity<9.0.0,>=8.2.3",
    "pydantic>2.0",
    "emails<1.0,>=0.6",
    "jinja2<4.0.0,>=3.1.4",
    "alembic<2.0.0,>=1.12.1",
    "httpx<1.0.0,>=0.25.1",
    "psycopg[binary]<4.0.0,>=3.1.13",
    "sqlmodel<1.0.0,>=0.0.21",
    "bcrypt==4.0.1",
    "pydantic-settings<3.0.0,>=2.2.1",
    "sentry-sdk[fastapi]<2.0.0,>=1.40.6",
    "pyjwt<3.0.0,>=2.8.0",
]

[tool.uv]
dev-dependencies = [
    "pytest<8.0.0,>=7.4.3",
    "mypy<2.0.0,>=1.8.0",
]
`,
      "uv.lock": "",
      "alembic.ini": "",
      "app/__init__.py": "",
      "app/main.py": `import sentry_sdk
from fastapi import FastAPI
from fastapi.routing import APIRoute
from starlette.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.core.config import settings


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
)

app.include_router(api_router, prefix=settings.API_V1_STR)
`,
      "app/api/main.py": "",
      "app/core/config.py": "",
      "app/models.py": "",
      "app/crud.py": "",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi typed app object in api.py",
    files: {
      "api.py": `from fastapi import FastAPI

api: FastAPI = FastAPI(title="Inventory")


@api.get("/items")
async def items():
    return []
`,
      "requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.6\nsqlalchemy\n",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn api:api --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi poetry with standard extra",
    files: {
      "pyproject.toml": `[tool.poetry]
name = "service"
version = "0.1.0"
description = ""
authors = ["Dev <dev@example.com>"]

[tool.poetry.dependencies]
python = "^3.11"
fastapi = {extras = ["standard"], version = "^0.115.0"}
httpx = "^0.27.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
`,
      "poetry.lock": "",
      "main.py": FASTAPI_HELLO,
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi in src directory",
    files: {
      "src/main.py": FASTAPI_HELLO,
      "src/routers/users.py": "",
      "requirements.txt": "fastapi\nuvicorn\n",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn src.main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi that calls uvicorn.run with PORT",
    files: {
      "main.py": `import os

import uvicorn
from fastapi import FastAPI

app = FastAPI()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]))
`,
      "requirements.txt": "fastapi\nuvicorn\n",
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "fastapi multi-line pyproject dependencies",
    files: {
      "pyproject.toml": `[project]
name = "svc"
version = "0.1.0"
dependencies = [
  "fastapi",
  "uvicorn",
]

[project.optional-dependencies]
dev = ["pytest", "gunicorn"]
`,
      "server.py": FASTAPI_HELLO,
    },
    expected: {
      framework: "fastapi",
      startCommand: "uvicorn server:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "django tutorial mysite",
    files: { ...MYSITE, "requirements.txt": "Django>=5.0\n" },
    expected: {
      framework: "django",
      startCommand: "python manage.py runserver 0.0.0.0:$PORT --noreload",
    },
  },
  {
    name: "django with gunicorn and postgres",
    files: {
      ...MYSITE,
      "requirements.txt":
        "django==5.1.1\ngunicorn==23.0.0\npsycopg2-binary==2.9.9\nwhitenoise\n",
    },
    expected: {
      framework: "django",
      startCommand: "gunicorn mysite.wsgi --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "django with uvicorn",
    files: { ...MYSITE, "requirements.txt": "django\nuvicorn\nchannels\n" },
    expected: {
      framework: "django",
      startCommand:
        "uvicorn mysite.asgi:application --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "cookiecutter-django (split requirements, config package)",
    files: {
      "manage.py": DJANGO_MANAGE("config.settings.local"),
      "config/__init__.py": "",
      "config/settings/base.py": "",
      "config/settings/production.py": "",
      "config/urls.py": "",
      "config/wsgi.py": DJANGO_WSGI("config"),
      "config/asgi.py": DJANGO_ASGI("config"),
      "requirements.txt":
        "# This file is expected by Heroku.\n\n-r requirements/production.txt\n",
      "requirements/base.txt":
        "python-slugify==8.0.4\nargon2-cffi==23.1.0\ndjango==5.0.9\n",
      "requirements/production.txt":
        "-r base.txt\n\ngunicorn==23.0.0  # https://github.com/benoitc/gunicorn\npsycopg[c]==3.2.2\n",
      "requirements/local.txt": "-r base.txt\n\nWerkzeug[watchdog]==3.0.4\n",
    },
    expected: {
      framework: "django",
      startCommand: "gunicorn config.wsgi --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "django poetry project",
    files: {
      ...MYSITE,
      "pyproject.toml": `[tool.poetry]
name = "mysite"
version = "0.1.0"
package-mode = false

[tool.poetry.dependencies]
python = "^3.12"
django = "^5.1"
gunicorn = "^23.0"

[tool.poetry.group.dev.dependencies]
pytest-django = "^4.9"
`,
      "poetry.lock": "",
    },
    expected: {
      framework: "django",
      startCommand: "gunicorn mysite.wsgi --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "django with a Procfile",
    files: {
      ...MYSITE,
      "requirements.txt": "django\ngunicorn\n",
      "Procfile":
        "release: python manage.py migrate\nweb: gunicorn mysite.wsgi --log-file -\n",
    },
    expected: {
      framework: "django",
      startCommand: "gunicorn mysite.wsgi --log-file -",
    },
  },
  {
    name: "streamlit single app",
    files: {
      "streamlit_app.py": `import pandas as pd
import streamlit as st

st.title("Uber pickups in NYC")
`,
      "requirements.txt": "streamlit\npandas\nnumpy\n",
    },
    expected: {
      framework: "streamlit",
      startCommand:
        "streamlit run streamlit_app.py --server.address 0.0.0.0 --server.port $PORT --server.headless true",
    },
  },
  {
    name: "streamlit multipage with Home.py",
    files: {
      "Home.py":
        'import streamlit as st\n\nst.set_page_config(page_title="Hello")\n',
      "pages/1_Plotting.py": "import streamlit as st\n",
      "utils.py": "def helper():\n    return 1\n",
      "requirements.txt": "streamlit==1.38.0\naltair\n",
    },
    expected: {
      framework: "streamlit",
      startCommand:
        "streamlit run Home.py --server.address 0.0.0.0 --server.port $PORT --server.headless true",
    },
  },
  {
    name: "gradio hugging face space",
    files: {
      "app.py": `import gradio as gr


def greet(name):
    return "Hello " + name + "!"


demo = gr.Interface(fn=greet, inputs="text", outputs="text")
demo.launch()
`,
      "requirements.txt": "gradio\ntransformers\ntorch\n",
    },
    expected: {
      framework: "gradio",
      startCommand:
        "env GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=$PORT python app.py",
    },
  },
  {
    name: "plotly dash dashboard with gunicorn",
    files: {
      "app.py": `from dash import Dash, html, dcc
import plotly.express as px

app = Dash(__name__)
server = app.server

app.layout = html.Div([html.H1("Dashboard")])

if __name__ == "__main__":
    app.run(debug=True)
`,
      "requirements.txt": "dash\npandas\ngunicorn\n",
    },
    expected: {
      framework: "dash",
      startCommand: "gunicorn app:server --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "plotly dash without gunicorn",
    files: {
      "app.py": `import dash
from dash import html

app = dash.Dash(__name__)
app.layout = html.Div("Hello Dash")

if __name__ == "__main__":
    app.run()
`,
      "requirements.txt": "dash\n",
    },
    expected: {
      framework: "dash",
      startCommand: "env HOST=0.0.0.0 python app.py",
    },
  },
  {
    name: "sanic hello world",
    files: {
      "server.py": `from sanic import Sanic
from sanic.response import text

app = Sanic("MyHelloWorldApp")


@app.get("/")
async def hello_world(request):
    return text("Hello, world.")
`,
      "requirements.txt": "sanic\n",
    },
    expected: {
      framework: "sanic",
      startCommand: "sanic server:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "litestar with standard extra",
    files: {
      "app.py": `from litestar import Litestar, get


@get("/")
async def index() -> str:
    return "Hello, world!"


app = Litestar([index])
`,
      "requirements.txt": "litestar[standard]\n",
    },
    expected: {
      framework: "litestar",
      startCommand: "uvicorn app:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "litestar bare",
    files: {
      "app.py": `from litestar import Litestar, get


@get("/")
async def index() -> str:
    return "Hello, world!"


app = Litestar([index])
`,
      "requirements.txt": "litestar\n",
    },
    expected: {
      framework: "litestar",
      startCommand: "litestar --app app:app run --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "quart app",
    files: {
      "app.py": `from quart import Quart

app = Quart(__name__)


@app.route("/")
async def hello():
    return "hello"
`,
      "requirements.txt": "quart\n",
    },
    expected: {
      framework: "quart",
      startCommand: "quart --app app run --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "starlette with uvicorn",
    files: {
      "main.py": `from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def homepage(request):
    return JSONResponse({"hello": "world"})


app = Starlette(debug=True, routes=[Route("/", homepage)])
`,
      "requirements.txt": "starlette\nuvicorn\n",
    },
    expected: {
      framework: "starlette",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    },
  },
  {
    name: "bottle that reads PORT",
    files: {
      "app.py": `import os

from bottle import Bottle, run

app = Bottle()


@app.route("/")
def index():
    return "hi"


if __name__ == "__main__":
    run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
`,
      "requirements.txt": "bottle\n",
    },
    expected: {
      framework: "bottle",
      startCommand: "python app.py",
    },
  },
  {
    name: "falcon with gunicorn",
    files: {
      "app.py": `import falcon


class ThingsResource:
    def on_get(self, req, resp):
        resp.media = {"ok": True}


app = falcon.App()
app.add_route("/things", ThingsResource())
`,
      "requirements.txt": "falcon\ngunicorn\n",
    },
    expected: {
      framework: "falcon",
      startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT",
    },
  },
  {
    name: "aiohttp server",
    files: {
      "server.py": `import os

from aiohttp import web


async def handle(request):
    return web.Response(text="Hello")


app = web.Application()
app.add_routes([web.get("/", handle)])

if __name__ == "__main__":
    web.run_app(app, port=int(os.environ.get("PORT", 8080)))
`,
      "requirements.txt": "aiohttp\n",
    },
    expected: {
      framework: "script",
      startCommand: "python server.py",
    },
  },
  {
    name: "nicegui app",
    files: {
      "main.py": `from nicegui import ui

ui.label("Hello NiceGUI!")

ui.run()
`,
      "requirements.txt": "nicegui\n",
    },
    expected: {
      framework: "script",
      startCommand: "python main.py",
    },
  },
  {
    name: "discord bot",
    files: {
      "bot.py": `import os

import discord

intents = discord.Intents.default()
client = discord.Client(intents=intents)

client.run(os.environ["DISCORD_TOKEN"])
`,
      "requirements.txt": "discord.py\n",
    },
    expected: {
      framework: "script",
      startCommand: "python bot.py",
    },
  },
  {
    name: "telegram bot in main.py",
    files: {
      "main.py": `import os

from telegram.ext import ApplicationBuilder

app = ApplicationBuilder().token(os.environ["TOKEN"]).build()
app.run_polling()
`,
      "handlers.py": "",
      "requirements.txt": "python-telegram-bot==21.5\n",
    },
    expected: {
      framework: "script",
      startCommand: "python main.py",
    },
  },
  {
    name: "lone scraper script",
    files: {
      "scraper.py": `import requests
from bs4 import BeautifulSoup

print(BeautifulSoup(requests.get("https://example.com").text, "html.parser").title)
`,
      "requirements.txt": "requests\nbeautifulsoup4\n",
    },
    expected: {
      framework: "script",
      startCommand: "python scraper.py",
    },
  },
  {
    name: "bare stdlib http server script",
    files: {
      "serve.py": `import http.server
import os

port = int(os.environ.get("PORT", "8000"))
http.server.ThreadingHTTPServer(("0.0.0.0", port), http.server.SimpleHTTPRequestHandler).serve_forever()
`,
    },
    expected: {
      framework: "script",
      startCommand: "python serve.py",
    },
  },
  {
    name: "ambiguous scripts with no entry",
    files: {
      "scrape.py": "import requests\n",
      "report.py": "import csv\n",
      "requirements.txt": "requests\n",
    },
    expected: {},
  },
  {
    name: "celery worker",
    files: {
      "tasks.py": `from celery import Celery

app = Celery("tasks", broker="redis://localhost")


@app.task
def add(x, y):
    return x + y
`,
      "requirements.txt": "celery[redis]\n",
    },
    expected: {
      framework: "celery",
      startCommand: "celery -A tasks worker --loglevel=info",
    },
  },
];
