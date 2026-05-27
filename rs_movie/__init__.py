import os
import uvicorn


def run():
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)


def run_dev():
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
