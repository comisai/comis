package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/comisai/comis-dev-crew/internal/reporter"
)

func main() {
	client, err := reporter.NewMountedRuntimeClient(
		os.Getenv("COMIS_EXECUTION_ATTACHMENT"),
		os.Getenv("COMIS_EXECUTION_ATTACHMENT_TARGET_NAME"),
		os.Getenv("COMIS_EXECUTION_ATTACHMENT_IDENTITY"),
		5*time.Second,
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "construct=%v\n", err)
		os.Exit(1)
	}
	if _, err := client.Brief(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "brief=%v\n", err)
		os.Exit(1)
	}
	fmt.Println("brief=ok")
}
