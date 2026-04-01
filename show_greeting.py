import sys

def greeting(name):
    # Ensure the response is a single block of text without truncation
    response = f"Hey {name}"
    print(response)

if __name__ == '__main__':
    greeting(sys.argv[1])
