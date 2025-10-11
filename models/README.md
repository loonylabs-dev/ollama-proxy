# Custom GGUF Models for Ollama

This directory contains custom GGUF models from Hugging Face and their Ollama Modelfiles.

## Quick Start

### 1. Download GGUF Model

```bash
# Example: Download from Hugging Face
wget https://huggingface.co/user/model-repo/resolve/main/model.gguf -P ./models/gguf/
```

### 2. Create Modelfile

```bash
# Copy the example
cp models/modelfiles/example.Modelfile models/modelfiles/my-model.Modelfile

# Edit the Modelfile:
# - Set FROM path to your GGUF file
# - Adjust TEMPLATE for your model's format
# - Configure PARAMETER values
```

### 3. Import to Ollama

The `./models` directory is mounted to `/models` in the Ollama GPU container.

```bash
# Import your model
docker exec ollama-proxy-ollama-gpu-1 ollama create my-model -f /models/modelfiles/my-model.Modelfile

# List models
docker exec ollama-proxy-ollama-gpu-1 ollama list

# Test the model
docker exec -it ollama-proxy-ollama-gpu-1 ollama run my-model
```

### 4. Use via Proxy

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"model": "my-model", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Directory Structure

```
models/
├── gguf/              # GGUF model files (gitignored)
│   ├── .gitkeep
│   └── *.gguf
├── modelfiles/        # Ollama Modelfiles
│   ├── example.Modelfile  # Template (tracked in git)
│   └── *.Modelfile        # Your custom files (gitignored)
└── README.md
```

## Resources

- [Ollama Modelfile Reference](https://github.com/ollama/ollama/blob/main/docs/modelfile.md)
- [Hugging Face GGUF Models](https://huggingface.co/models?library=gguf)
