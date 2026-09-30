package invites

import (
	"regexp"
	"testing"
)

func TestNewCodesArePlainToReadAndDistinct(t *testing.T) {
	shape := regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := New()
		if err != nil {
			t.Fatal(err)
		}
		if !shape.MatchString(code) {
			t.Fatalf("%q is not four groups of four", code)
		}
		if seen[code] {
			t.Fatalf("%q came twice", code)
		}
		seen[code] = true
	}
}

func TestACodeReadsTheSameHoweverItIsTyped(t *testing.T) {
	want := Hash("7K2M-9Q1D-X04B-HF3R")
	for _, typed := range []string{"7k2m9q1dx04bhf3r", "7K2M 9QID X0 4B HF3R", "7k2m-9qld-xo4b-hf3r"} {
		if Hash(typed) != want {
			t.Errorf("%q reads as another code", typed)
		}
	}
	if Hash("7K2M-9Q1D-X04B-HF3S") == want {
		t.Error("another code reads as this one")
	}
}
