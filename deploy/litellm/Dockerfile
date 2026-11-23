FROM python:3.12-slim
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple "litellm[proxy]==1.74.9"
WORKDIR /app
EXPOSE 4000
ENTRYPOINT ["litellm"]
