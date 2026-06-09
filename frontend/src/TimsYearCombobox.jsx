import { useEffect, useMemo, useRef, useState } from 'react'

function TimsYearCombobox({ value, years, onChange }) {
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState(value)
  const containerRef = useRef(null)

  useEffect(() => {
    setInputValue(value)
  }, [value])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const options = useMemo(
    () => [
      { value: '', label: 'All years' },
      ...years.map((year) => ({ value: String(year), label: String(year) })),
    ],
    [years],
  )

  const filteredOptions = useMemo(() => {
    const query = inputValue.trim().toLowerCase()
    if (!query) {
      return options
    }

    return options.filter((option) =>
      option.label.toLowerCase().includes(query),
    )
  }, [inputValue, options])

  const selectOption = (optionValue) => {
    setInputValue(optionValue)
    onChange(optionValue)
    setOpen(false)
  }

  return (
    <div className="tims-year-combobox" ref={containerRef}>
      <input
        type="text"
        className="weight-field-combobox"
        value={inputValue}
        onChange={(event) => {
          setInputValue(event.target.value)
          onChange(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder="All years"
        inputMode="numeric"
        autoComplete="off"
      />
      {open && filteredOptions.length > 0 && (
        <ul className="tims-year-combobox-list" role="listbox">
          {filteredOptions.map((option) => (
            <li key={option.value || 'all-years'}>
              <button
                type="button"
                className={
                  option.value === inputValue ? 'is-selected' : undefined
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option.value)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default TimsYearCombobox
