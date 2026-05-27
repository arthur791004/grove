{
  "targets": [
    {
      "target_name": "grove_termios",
      "sources": ["src/termios.c"],
      "conditions": [
        ["OS==\"win\"", {
          "sources!": ["src/termios.c"],
          "sources": ["src/termios_stub.c"]
        }]
      ]
    }
  ]
}
