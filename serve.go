// Command serve hosts the web/ folder for development and opens it in a
// browser. fetch() is blocked on file:// URLs, so the asset sheet needs a real
// HTTP origin to load entities.json.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Windows registry MIME lookups are unreliable; be explicit.
var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".webp": "image/webp",
	".ogg":  "audio/ogg",
	".wav":  "audio/wav",
}

type handler struct{ h http.Handler }

func (x handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if ct, ok := mimeTypes[strings.ToLower(filepath.Ext(r.URL.Path))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-cache")
	x.h.ServeHTTP(w, r)
}

func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default:
		err = exec.Command("xdg-open", url).Start()
	}
	if err != nil {
		log.Printf("could not open a browser automatically: %v", err)
	}
}

func main() {
	port := flag.Int("port", 8080, "port to listen on")
	noOpen := flag.Bool("no-open", false, "do not open a browser automatically")
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	if exe, err := os.Executable(); err == nil {
		if dir := filepath.Dir(exe); exists(filepath.Join(dir, "index.html")) {
			root = dir
		}
	}
	if !exists(filepath.Join(root, "index.html")) {
		log.Fatal("no index.html here — run this from the web/ folder")
	}

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("cannot listen on %s: %v (try -port 9000)", addr, err)
	}

	url := "http://" + addr + "/"
	fmt.Printf("\n  Orbital Claim dev server: %s\n  Serving %s\n  Ctrl+C to stop.\n\n", url, root)
	if !*noOpen {
		go openBrowser(url)
	}
	log.Fatal(http.Serve(ln, handler{http.FileServer(http.Dir(root))}))
}

func exists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
