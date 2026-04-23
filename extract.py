import re

with open('src/store.ts', 'r') as f:
    content = f.read()

print("File size:", len(content))
