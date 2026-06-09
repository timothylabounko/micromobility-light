const CITY_API_URL = import.meta.env.DEV
  ? '/api/city'
  : 'http://127.0.0.1:8000/api/city'

export async function loadCityStreetNetwork(cityName, options = {}) {
  try {
    const response = await fetch(CITY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        city: cityName,
        weights: options.weights,
        accident_year: options.accidentYear ?? null,
        recalculate: options.recalculate ?? false,
      }),
    })

    if (!response.ok) {
      throw new Error('City analysis request failed.')
    }

    return await response.json()
  } catch {
    return {
      status: 'error',
      message: 'Something went wrong while loading the street network. Please try again.',
    }
  }
}
